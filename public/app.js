'use strict';

/* 全局状态：rows 为当前校订结果，结构：
 * { id, text, start, end, sim, oldRefs:[{index,text}], baseFlags:[], ack, locked, evenizeFail, cutFail }
 * baseFlags 来自服务端（uncertain / unmatched），ack 后清除；
 * reversed / overlap / crosses 每次渲染前实时重算（crosses 依据 state.cuts 镜头切点）；
 * locked 为行内时码锁定开关（匀时/避切点时保持不动）；
 * evenizeFail 标记最近一次匀时容量不足的区间；cutFail 标记最近一次避切点无可行方案的行。
 */
const state = {
  rows: [],
  droppedOld: [],
  nextId: 1,
  pendingOnly: false,
  lastSrt: '',
  cuts: [], // 镜头切点（毫秒），避切点成功后由服务端返回
};

const $ = (sel) => document.querySelector(sel);

const FLAG_LABELS = {
  uncertain: '不确定',
  unmatched: '未匹配',
  reversed: '倒序',
  overlap: '重叠',
  crosses: '跨切点',
};

/* ---------- 时码工具 ---------- */

function pad(v, n) { return String(v).padStart(n, '0'); }

function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

function parseTimecode(str) {
  const m = String(str).trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4].padEnd(3, '0').slice(0, 3));
}

/* ---------- 行级计算（与服务端规则一致） ---------- */

function computeFlags(rows) {
  rows.forEach((r, k) => {
    const flags = new Set(r.baseFlags);
    if (r.start != null && r.end != null && r.end <= r.start) flags.add('reversed');
    if (k > 0 && r.start != null && rows[k - 1].end != null && r.start < rows[k - 1].end) flags.add('overlap');
    if (state.cuts.length && r.start != null && r.end != null && r.end > r.start) {
      for (const c of state.cuts) {
        if (r.start < c && c < r.end) {
          flags.add('crosses');
          break;
        }
      }
    }
    r.flags = [...flags];
  });
}

function splitRangeByLength(start, end, t1, t2) {
  const dur = end - start;
  const l1 = Math.max(1, t1.trim().length);
  const l2 = Math.max(1, t2.trim().length);
  let cut = dur <= 0 ? start : Math.round(start + (dur * l1) / (l1 + l2));
  if (dur >= 800) cut = Math.max(start + 400, Math.min(end - 400, cut));
  return [[start, cut], [cut, end]];
}

/* ---------- 上传与对齐 ---------- */

async function loadFileInto(file, target) {
  if (!file) return;
  $(target).value = await file.text();
}

$('#srtFile').addEventListener('change', (e) => loadFileInto(e.target.files[0], '#srtText'));
$('#revFile').addEventListener('change', (e) => loadFileInto(e.target.files[0], '#revText'));

$('#alignBtn').addEventListener('click', async () => {
  const msg = $('#alignMsg');
  msg.className = 'msg';
  msg.textContent = '对齐中…';
  try {
    const res = await fetch('/api/align', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srt: $('#srtText').value, revised: $('#revText').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '对齐失败');
    state.rows = data.rows.map((r) => ({
      id: state.nextId++,
      text: r.text,
      start: r.start,
      end: r.end,
      sim: r.sim,
      oldRefs: r.oldRefs || [],
      baseFlags: (r.flags || []).filter((f) => f === 'uncertain' || f === 'unmatched'),
      ack: false,
      locked: false,
      evenizeFail: false,
      cutFail: false,
    }));
    state.droppedOld = data.droppedOld || [];
    $('#evenizeMsg').classList.add('hidden');
    $('#cutMsg').classList.add('hidden');
    renderStats(data.stats);
    renderDropped();
    renderRows();
    $('#step-review').classList.remove('hidden');
    $('#step-preview').classList.add('hidden');
    msg.className = 'msg ok';
    msg.textContent = `对齐完成：${data.stats.rowCount} 行输出，${data.stats.pending} 行待处理`;
    $('#step-review').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    msg.textContent = err.message;
  }
});

/* ---------- 渲染 ---------- */

function renderStats(s) {
  $('#statsBar').innerHTML = [
    `<span class="stat"><b>${s.oldCount}</b>旧条目</span>`,
    `<span class="stat"><b>${s.revisedCount}</b>修订行</span>`,
    `<span class="stat"><b>${s.rowCount}</b>输出行</span>`,
    `<span class="stat"><b>${s.splits}</b>拆分</span>`,
    `<span class="stat"><b>${s.merges}</b>合并</span>`,
    `<span class="stat ok"><b>${s.ok}</b>正常</span>`,
    `<span class="stat warn"><b>${s.pending}</b>待处理</span>`,
    `<span class="stat"><b>${s.dropped}</b>旧条目被丢弃</span>`,
  ].join('');
}

function refreshStatsPending() {
  computeFlags(state.rows);
  const pending = state.rows.filter((r) => r.flags.length > 0).length;
  const ok = state.rows.length - pending;
  const stats = $('#statsBar').children;
  if (stats.length >= 7) {
    stats[5].querySelector('b').textContent = ok;
    stats[6].querySelector('b').textContent = pending;
  }
}

function renderDropped() {
  const box = $('#droppedBox');
  const list = $('#droppedList');
  list.innerHTML = '';
  if (!state.droppedOld.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  for (const d of state.droppedOld) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="nums">#${d.index} [${formatMs(d.start)} → ${formatMs(d.end)}]</span> <span class="t"></span>`;
    li.querySelector('.t').textContent = d.text;
    list.appendChild(li);
  }
}

function rowMatchesFilter(row) {
  if (!state.pendingOnly) return true;
  return row.flags.length > 0;
}

function renderRows() {
  computeFlags(state.rows);
  const tbody = $('#rowsBody');
  tbody.innerHTML = '';
  state.rows.forEach((row, idx) => {
    if (!rowMatchesFilter(row)) return;
    tbody.appendChild(buildRow(row, idx));
  });
  refreshStatsPending();
}

function buildRow(row, idx) {
  const tr = document.createElement('tr');
  tr.dataset.id = row.id;
  if (row.flags.length) tr.classList.add('pending');
  if (row.ack) tr.classList.add('acked');
  if (row.locked) tr.classList.add('locked');
  if (row.evenizeFail) tr.classList.add('evenize-fail');
  if (row.cutFail) tr.classList.add('cut-fail');

  // #
  const tdNo = document.createElement('td');
  tdNo.textContent = idx + 1;
  tr.appendChild(tdNo);

  // 时码锁定
  const tdLock = document.createElement('td');
  tdLock.className = 'lock-col';
  const lockCb = document.createElement('input');
  lockCb.type = 'checkbox';
  lockCb.checked = !!row.locked;
  lockCb.title = row.locked ? '已锁定：匀时时保持本行时码不变' : '勾选后匀时时保持本行时码不变';
  lockCb.addEventListener('change', () => {
    row.locked = lockCb.checked;
    row.evenizeFail = false;
    row.cutFail = false;
    renderRows();
  });
  tdLock.appendChild(lockCb);
  tr.appendChild(tdLock);

  // 修订台词（可编辑）
  const tdText = document.createElement('td');
  const ta = document.createElement('textarea');
  ta.className = 'line-text';
  ta.rows = Math.min(3, Math.max(1, row.text.split('\n').length));
  ta.value = row.text;
  ta.spellcheck = false;
  ta.addEventListener('input', () => { row.text = ta.value; row.evenizeFail = false; row.cutFail = false; });
  tdText.appendChild(ta);
  tr.appendChild(tdText);

  // 对应旧字幕
  const tdOld = document.createElement('td');
  const oldDiv = document.createElement('div');
  oldDiv.className = 'oldref';
  if (row.oldRefs.length) {
    const nums = row.oldRefs.map((o) => `#${o.index}`).join(' + ');
    const preview = row.oldRefs.map((o) => o.text.replace(/\n/g, ' / ')).join(' ⏎ ');
    oldDiv.innerHTML = `<span class="nums"></span><br><span class="txt"></span>`;
    oldDiv.querySelector('.nums').textContent = nums;
    oldDiv.querySelector('.txt').textContent = preview.length > 60 ? preview.slice(0, 60) + '…' : preview;
  } else {
    oldDiv.classList.add('none');
    oldDiv.textContent = '无对应旧字幕';
  }
  tdOld.appendChild(oldDiv);
  tr.appendChild(tdOld);

  // 相似度
  const tdSim = document.createElement('td');
  const simSpan = document.createElement('span');
  simSpan.className = 'sim' + (row.sim != null && row.sim < 0.45 ? ' low' : '');
  simSpan.textContent = row.sim == null ? '—' : row.sim.toFixed(2);
  tdSim.appendChild(simSpan);
  tr.appendChild(tdSim);

  // 时码
  for (const field of ['start', 'end']) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.className = 'time-input';
    input.value = formatMs(row[field]);
    input.dataset.field = field;
    input.disabled = !!row.locked;
    input.title = row.locked ? '该行时码已锁定，取消锁定后可编辑' : '';
    input.addEventListener('change', () => {
      const v = parseTimecode(input.value);
      if (v == null) {
        input.classList.add('invalid');
        return;
      }
      input.classList.remove('invalid');
      row[field] = v;
      row.evenizeFail = false;
      row.cutFail = false;
      input.value = formatMs(v);
      renderRows();
    });
    td.appendChild(input);
    tr.appendChild(td);
  }

  // 标记
  const tdFlags = document.createElement('td');
  for (const f of row.flags) {
    const b = document.createElement('span');
    b.className = `badge ${f}`;
    b.textContent = FLAG_LABELS[f] || f;
    tdFlags.appendChild(b);
  }
  tr.appendChild(tdFlags);

  // 操作
  const tdOps = document.createElement('td');
  const mkBtn = (label, title, fn, disabled) => {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = label;
    b.title = title;
    b.disabled = !!disabled;
    b.addEventListener('click', fn);
    tdOps.appendChild(b);
    return b;
  };
  mkBtn('拆分', '把本行拆成两条，按文字长度分配时段', () => openSplitEditor(tr, row));
  mkBtn('合并', '与下一行合并为一条，沿用覆盖时段', () => mergeWithNext(row), idx >= state.rows.length - 1);
  if (row.baseFlags.length) {
    mkBtn('确认', '确认本行配对无误，清除待处理标记', () => {
      row.baseFlags = [];
      row.ack = true;
      renderRows();
    });
  }
  mkBtn('删除', '从导出结果中移除本行', () => {
    state.rows = state.rows.filter((r) => r.id !== row.id);
    renderRows();
  });
  tr.appendChild(tdOps);

  return tr;
}

/* ---------- 配对修改：拆分 / 合并 ---------- */

let splitEditorTr = null;

function closeSplitEditor() {
  if (splitEditorTr) {
    splitEditorTr.remove();
    splitEditorTr = null;
  }
}

function openSplitEditor(anchorTr, row) {
  closeSplitEditor();
  const text = row.text.replace(/\n/g, '');
  if (text.length < 2) return;
  const tr = document.createElement('tr');
  tr.className = 'split-editor';
  const td = document.createElement('td');
  td.colSpan = 9;

  const label = document.createElement('div');
  label.innerHTML = '在第 <input type="number"> 个字符后拆分（共 ' + text.length + ' 字）';
  const numInput = label.querySelector('input');
  numInput.type = 'number';
  numInput.min = 1;
  numInput.max = text.length - 1;
  numInput.value = Math.max(1, Math.round(text.length / 2));

  const preview = document.createElement('div');
  preview.className = 'split-preview';
  const updatePreview = () => {
    const p = Math.min(text.length - 1, Math.max(1, Number(numInput.value) || 1));
    preview.innerHTML = '';
    const a = document.createElement('span');
    a.textContent = text.slice(0, p);
    const cut = document.createElement('span');
    cut.className = 'cut';
    cut.textContent = ' ✂ ';
    const b = document.createElement('span');
    b.textContent = text.slice(p);
    preview.append(a, cut, b);
  };
  numInput.addEventListener('input', updatePreview);
  updatePreview();

  const okBtn = document.createElement('button');
  okBtn.className = 'small primary';
  okBtn.textContent = '确定拆分';
  okBtn.addEventListener('click', () => {
    const p = Math.min(text.length - 1, Math.max(1, Number(numInput.value) || 1));
    doSplit(row, p);
    closeSplitEditor();
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'small';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', closeSplitEditor);

  td.append(label, preview, okBtn, cancelBtn);
  tr.appendChild(td);
  anchorTr.after(tr);
  splitEditorTr = tr;
}

function doSplit(row, pos) {
  const text = row.text.replace(/\n/g, '');
  const t1 = text.slice(0, pos);
  const t2 = text.slice(pos);
  const [[s1, e1], [s2, e2]] = splitRangeByLength(row.start, row.end, t1, t2);
  const idx = state.rows.findIndex((r) => r.id === row.id);
  const mk = (t, s, e) => ({
    id: state.nextId++,
    text: t,
    start: s,
    end: e,
    sim: row.sim,
    oldRefs: row.oldRefs,
    baseFlags: [...row.baseFlags],
    ack: row.ack,
    locked: false,
    evenizeFail: false,
    cutFail: false,
  });
  state.rows.splice(idx, 1, mk(t1, s1, e1), mk(t2, s2, e2));
  renderRows();
}

function mergeWithNext(row) {
  const idx = state.rows.findIndex((r) => r.id === row.id);
  if (idx < 0 || idx >= state.rows.length - 1) return;
  const next = state.rows[idx + 1];
  const seen = new Set();
  const oldRefs = [...row.oldRefs, ...next.oldRefs].filter((o) => {
    if (seen.has(o.index)) return false;
    seen.add(o.index);
    return true;
  });
  const merged = {
    id: state.nextId++,
    text: row.text + '\n' + next.text,
    start: Math.min(row.start, next.start),
    end: Math.max(row.end, next.end),
    sim: Math.min(row.sim ?? 1, next.sim ?? 1),
    oldRefs,
    baseFlags: [...new Set([...row.baseFlags, ...next.baseFlags])],
    ack: row.ack && next.ack,
    locked: !!(row.locked && next.locked),
    evenizeFail: false,
    cutFail: false,
  };
  state.rows.splice(idx, 2, merged);
  renderRows();
}

/* ---------- 区间匀时 ---------- */

function formatDur(ms) {
  ms = Math.max(0, Math.round(ms));
  if (ms >= 1000) {
    const s = ms / 1000;
    return `${s.toFixed(ms % 1000 === 0 ? 0 : 2).replace(/\.?0+$/, '')} 秒`;
  }
  return `${ms} 毫秒`;
}

function showMsgParts(box, parts, kind) {
  box.classList.remove('hidden', 'ok', 'warn');
  box.classList.add(kind);
  box.innerHTML = '';
  for (const p of parts) {
    const div = document.createElement('div');
    if (p instanceof Node) {
      div.appendChild(p);
    } else {
      div.textContent = p;
    }
    box.appendChild(div);
  }
}

function showEvenizeMsg(parts, kind) {
  showMsgParts($('#evenizeMsg'), parts, kind);
}

function showCutMsg(parts, kind) {
  showMsgParts($('#cutMsg'), parts, kind);
}

function clearEvenizeMsg() {
  const box = $('#evenizeMsg');
  box.classList.add('hidden');
  box.className = 'msg hidden';
  box.innerHTML = '';
}

$('#evenizeBtn').addEventListener('click', async () => {
  const btn = $('#evenizeBtn');
  if (!state.rows.length) return;
  const unlocked = state.rows.filter((r) => !r.locked).length;
  if (!unlocked) {
    showEvenizeMsg(['所有行均已锁定，没有可匀时的区间。'], 'warn');
    return;
  }
  btn.disabled = true;
  try {
    const res = await fetch('/api/evenize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: state.rows.map((r) => ({ start: r.start, end: r.end, text: r.text, locked: r.locked })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '匀时失败');

    state.rows.forEach((r, i) => {
      const out = data.rows[i];
      if (out && !r.locked) {
        r.start = out.start;
        r.end = out.end;
      }
      r.evenizeFail = false;
      r.cutFail = false; // 时码已变，旧的避切点失败结论失效
    });
    for (const f of data.failures) {
      for (let i = f.from - 1; i <= f.to - 1; i++) {
        if (state.rows[i]) state.rows[i].evenizeFail = true;
      }
    }

    const parts = [];
    if (data.updated > 0) {
      parts.push(`已匀时 ${data.updated} 个区间、共 ${data.updatedRows} 行（按可见字数分配，单行 ≥ 400ms、行间 ≥ 100ms）。`);
    } else {
      parts.push('没有可更新的区间。');
    }
    if (data.failures.length) {
      for (const f of data.failures) {
        const lineTxt = f.from === f.to ? `第 ${f.from} 行` : `第 ${f.from}–${f.to} 行`;
        const span = document.createElement('span');
        span.textContent =
          `${lineTxt} 容量不足：需要 ${formatDur(f.required)}，可用 ${formatDur(f.available)}，已保留原时码。`;
        parts.push(span);
      }
    }
    showEvenizeMsg(parts, data.failures.length ? 'warn' : 'ok');
    renderRows();
    if (data.failures.length) {
      $('#rowsBody').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } catch (err) {
    showEvenizeMsg([err.message], 'warn');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- 镜头切点避切 ---------- */

$('#avoidCutsBtn').addEventListener('click', async () => {
  const btn = $('#avoidCutsBtn');
  if (!state.rows.length) return;
  const cutsText = $('#cutText').value;
  if (!cutsText.trim()) {
    showCutMsg(['请先输入镜头切点：每行一个，格式 HH:MM:SS,mmm。'], 'warn');
    return;
  }
  btn.disabled = true;
  try {
    const res = await fetch('/api/avoid-cuts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cutsText,
        rows: state.rows.map((r) => ({ start: r.start, end: r.end, locked: r.locked })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '避切点失败'); // 格式错误时 error 含输入行号

    state.cuts = data.cuts || [];
    state.rows.forEach((r, i) => {
      const out = data.rows[i];
      if (out && !r.locked) {
        r.start = out.start;
        r.end = out.end;
      }
      r.evenizeFail = false; // 时码已变，旧的匀时失败结论失效
      r.cutFail = false;
    });
    for (const f of data.failures) {
      for (const n of f.rows) {
        if (state.rows[n - 1]) state.rows[n - 1].cutFail = true;
      }
    }

    const parts = [];
    if (data.adjusted.length) {
      parts.push(`已避让 ${data.adjusted.length} 行（总时码改动最小）：${data.adjusted.map((n) => '#' + n).join('、')}。`);
    } else if (!data.failures.length) {
      parts.push('没有跨越切点的未锁定行需要调整。');
    }
    for (const f of data.failures) {
      parts.push(`第 ${f.rows.map((n) => '#' + n).join('、')} 行保留原时码：${f.reason}`);
    }
    computeFlags(state.rows);
    const still = state.rows.map((r, i) => (r.flags.includes('crosses') ? i + 1 : 0)).filter(Boolean);
    if (still.length) {
      parts.push(`仍跨越切点：${still.map((n) => '#' + n).join('、')}（锁定行或无可行方案行，预览时会再次提示）。`);
    }
    showCutMsg(parts, data.failures.length ? 'warn' : 'ok');
    renderRows();
  } catch (err) {
    showCutMsg([err.message], 'warn');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- 导出 / 预览 / 下载 ---------- */

$('#pendingOnly').addEventListener('change', (e) => {
  state.pendingOnly = e.target.checked;
  renderRows();
});

$('#exportBtn').addEventListener('click', async () => {
  const msg = $('#exportMsg');
  msg.className = 'msg';
  computeFlags(state.rows);
  const pendingRows = state.rows
    .map((r, i) => ({ r, i: i + 1 }))
    .filter(({ r }) => r.flags.length > 0);
  if (pendingRows.length) {
    const list = pendingRows.slice(0, 8).map(({ i }) => `#${i}`).join('、');
    if (!window.confirm(`仍有 ${pendingRows.length} 行待处理（${list}${pendingRows.length > 8 ? '…' : ''}），确定继续导出？`)) {
      return;
    }
  }
  msg.textContent = '生成中…';
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: state.rows.map((r) => ({ start: r.start, end: r.end, text: r.text })),
      }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '导出失败');
    }
    state.lastSrt = await res.text();
    $('#previewBox').textContent = state.lastSrt;
    const warnBox = $('#previewWarn');
    const warns = [];
    if (pendingRows.length) {
      warns.push(`注意：导出内容包含 ${pendingRows.length} 行曾标记为待处理的字幕，请确认已人工复核。`);
    }
    computeFlags(state.rows);
    const crossRows = state.rows.map((r, i) => (r.flags.includes('crosses') ? i + 1 : 0)).filter(Boolean);
    if (crossRows.length) {
      warns.push(
        `仍有 ${crossRows.length} 行跨越镜头切点：${crossRows.slice(0, 10).map((n) => '#' + n).join('、')}${crossRows.length > 10 ? '…' : ''}。可返回校订页调整或解除锁定后重新「避切点」。`
      );
    }
    if (warns.length) {
      warnBox.classList.remove('hidden');
      warnBox.innerHTML = '';
      for (const w of warns) {
        const div = document.createElement('div');
        div.textContent = w;
        warnBox.appendChild(div);
      }
    } else {
      warnBox.classList.add('hidden');
    }
    $('#step-preview').classList.remove('hidden');
    msg.className = 'msg ok';
    msg.textContent = '预览已生成';
    $('#step-preview').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('#downloadBtn').addEventListener('click', () => {
  if (!state.lastSrt) return;
  const blob = new Blob([state.lastSrt], { type: 'application/x-subrip;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'revised.srt';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#backBtn').addEventListener('click', () => {
  $('#step-preview').classList.add('hidden');
  $('#step-review').scrollIntoView({ behavior: 'smooth' });
});
