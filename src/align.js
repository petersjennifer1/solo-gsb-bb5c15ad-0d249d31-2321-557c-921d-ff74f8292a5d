'use strict';

/**
 * 全局顺序对齐引擎。
 *
 * 旧 SRT 字幕（带时码）与逐行修订台词做单调全局对齐，支持：
 *   1:1 配对、1 拆 2、2 并 1、跳过（旧条目被删 / 修订行新增）。
 * 由于对齐是全局单调最优，重复出现的相同台词会依据前后文位置被正确归位。
 *
 * 时段规则：
 *   - 配对：沿用原时段
 *   - 合并：沿用两条旧字幕的覆盖时段（first.start ~ second.end）
 *   - 拆分：按修订文字（归一化后）长度比例分配原时段，带最短时长保护
 *
 * 标记（flags）：
 *   uncertain  相似度低于阈值，配对不确定
 *   unmatched  修订行没有可对应的旧字幕
 *   reversed   时码倒序（end <= start）
 *   overlap    与上一行时段重叠
 */

const SPLIT_PENALTY = 0.18; // 拆分的结构惩罚
const MERGE_PENALTY = 0.18; // 合并的结构惩罚
const SKIP_PENALTY = 0.55; // 跳过一条的惩罚（> 不确定匹配代价时优先匹配）
const UNCERTAIN_SIM = 0.45; // 低于该相似度视为不确定
const MIN_CUE_MS = 400; // 拆分后每条的最短时长

const OP_PAIR = 1;
const OP_SPLIT = 2;
const OP_MERGE = 3;
const OP_SKIP_OLD = 4;
const OP_SKIP_REV = 5;

/** 归一化：去标点/空白/符号，全角转半角，小写化，剥除 <i> 等标签与 {\an8} 类覆盖标签。 */
function normalizeText(s) {
  const cleaned = String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .toLowerCase();
  let out = '';
  for (const ch of cleaned) {
    const code = ch.codePointAt(0);
    // 全角（含全角标点）先转半角，再统一按标点/符号/空白过滤
    const c = code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : ch;
    if (!/[\s\p{P}\p{S}]/u.test(c)) out += c;
  }
  return out;
}

function ngramCounts(s, n) {
  const map = new Map();
  if (s.length === 0) return map;
  if (s.length < n) {
    map.set(s, 1);
    return map;
  }
  for (let i = 0; i + n <= s.length; i++) {
    const g = s.slice(i, i + n);
    map.set(g, (map.get(g) || 0) + 1);
  }
  return map;
}

function dice(a, b, n) {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const A = ngramCounts(a, n);
  const B = ngramCounts(b, n);
  let sizeA = 0;
  let sizeB = 0;
  let inter = 0;
  for (const v of A.values()) sizeA += v;
  for (const v of B.values()) sizeB += v;
  for (const [k, v] of A) {
    const w = B.get(k);
    if (w) inter += Math.min(v, w);
  }
  return (2 * inter) / (sizeA + sizeB);
}

/** 相似度：unigram 与 bigram 的 Dice 均值，对中文短句较稳健。输入需已归一化。 */
function similarity(a, b) {
  if (a === b) return 1;
  return (dice(a, b, 1) + dice(a, b, 2)) / 2;
}

/** 按时长比例拆分时段，带最短时长保护。 */
function splitRange(start, end, norm1, norm2) {
  const dur = end - start;
  let cut;
  if (dur <= 0) {
    cut = start;
  } else {
    const l1 = Math.max(1, norm1.length);
    const l2 = Math.max(1, norm2.length);
    cut = Math.round(start + (dur * l1) / (l1 + l2));
    if (dur >= 2 * MIN_CUE_MS) {
      cut = Math.max(start + MIN_CUE_MS, Math.min(end - MIN_CUE_MS, cut));
    }
  }
  return [
    [start, cut],
    [cut, end],
  ];
}

/** 带状动态规划：j 只允许落在 i 对应的对角线 ± width 内，超出自动加宽重试。 */
function runDp(normO, normR, width) {
  const n = normO.length;
  const m = normR.length;
  const key = (i, j) => i * (m + 1) + j;

  const pairMemo = new Map();
  const splitMemo = new Map();
  const mergeMemo = new Map();

  const pairCost = (i, j) => {
    const k = key(i, j);
    let c = pairMemo.get(k);
    if (c === undefined) {
      c = 1 - similarity(normO[i], normR[j]);
      pairMemo.set(k, c);
    }
    return c;
  };
  const splitCost = (i, j) => {
    const k = key(i, j);
    let c = splitMemo.get(k);
    if (c === undefined) {
      c = 1 - similarity(normO[i], normR[j] + normR[j + 1]) + SPLIT_PENALTY;
      splitMemo.set(k, c);
    }
    return c;
  };
  const mergeCost = (i, j) => {
    const k = key(i, j);
    let c = mergeMemo.get(k);
    if (c === undefined) {
      c = 1 - similarity(normO[i] + normO[i + 1], normR[j]) + MERGE_PENALTY;
      mergeMemo.set(k, c);
    }
    return c;
  };

  const center = (i) => Math.round((i * m) / Math.max(1, n));
  const lo = (i) => Math.max(0, center(i) - width);
  const hi = (i) => Math.min(m, center(i) + width);

  const dp = new Array(n + 1);
  const bp = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Float64Array(hi(i) - lo(i) + 1).fill(Infinity);
    bp[i] = new Uint8Array(hi(i) - lo(i) + 1);
  }
  const get = (i, j) => (j < lo(i) || j > hi(i) ? Infinity : dp[i][j - lo(i)]);
  const relax = (i, j, cost, op) => {
    if (j < lo(i) || j > hi(i)) return;
    const slot = j - lo(i);
    if (cost < dp[i][slot]) {
      dp[i][slot] = cost;
      bp[i][slot] = op;
    }
  };

  relax(0, 0, 0, 0);
  for (let i = 0; i <= n; i++) {
    for (let j = lo(i); j <= hi(i); j++) {
      const cur = dp[i][j - lo(i)];
      if (cur === Infinity) continue;
      if (i < n && j < m) relax(i + 1, j + 1, cur + pairCost(i, j), OP_PAIR);
      if (i < n && j + 1 < m) relax(i + 1, j + 2, cur + splitCost(i, j), OP_SPLIT);
      if (i + 1 < n && j < m) relax(i + 2, j + 1, cur + mergeCost(i, j), OP_MERGE);
      if (i < n) relax(i + 1, j, cur + SKIP_PENALTY, OP_SKIP_OLD);
      if (j < m) relax(i, j + 1, cur + SKIP_PENALTY, OP_SKIP_REV);
    }
  }

  const cost = get(n, m);
  const ops = [];
  if (cost !== Infinity) {
    let i = n;
    let j = m;
    let guard = (n + m) * 3 + 10;
    while ((i > 0 || j > 0) && guard-- > 0) {
      const op = bp[i][j - lo(i)];
      if (op === 0) break;
      ops.push(op);
      if (op === OP_PAIR) {
        i -= 1;
        j -= 1;
      } else if (op === OP_SPLIT) {
        i -= 1;
        j -= 2;
      } else if (op === OP_MERGE) {
        i -= 2;
        j -= 1;
      } else if (op === OP_SKIP_OLD) {
        i -= 1;
      } else {
        j -= 1;
      }
    }
    ops.reverse();
  }
  return { cost, ops };
}

/** 为未匹配的修订行插值一个临时时段（前后行之间），并保留 unmatched 标记。 */
function interpolateUnmatched(rows) {
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if (r.start != null && r.end != null) continue;
    const prevEnd = k > 0 && rows[k - 1].end != null ? rows[k - 1].end : 0;
    let nextStart = null;
    for (let t = k + 1; t < rows.length; t++) {
      if (rows[t].start != null) {
        nextStart = rows[t].start;
        break;
      }
    }
    r.start = prevEnd;
    r.end = nextStart != null && nextStart > prevEnd ? nextStart : prevEnd + 1500;
  }
}

/** 重算时间类标记与不确定标记（直接修改 rows）。 */
function flagRows(rows) {
  rows.forEach((r, k) => {
    const flags = new Set(r.flags);
    flags.delete('reversed');
    flags.delete('overlap');
    if (r.start != null && r.end != null && r.end <= r.start) flags.add('reversed');
    if (
      k > 0 &&
      r.start != null &&
      rows[k - 1].end != null &&
      r.start < rows[k - 1].end
    ) {
      flags.add('overlap');
    }
    if (!flags.has('unmatched') && r.sim != null && r.sim < UNCERTAIN_SIM) {
      flags.add('uncertain');
    } else {
      flags.delete('uncertain');
    }
    r.flags = [...flags];
  });
  return rows;
}

/**
 * 主入口：oldCues = [{index,start,end,text}], revLines = [string]
 * 返回 { rows, droppedOld, stats }
 */
function alignRevised(oldCues, revLines, opts = {}) {
  const n = oldCues.length;
  const m = revLines.length;
  const normO = oldCues.map((c) => normalizeText(c.text));
  const normR = revLines.map((l) => normalizeText(l));

  let width =
    opts.bandWidth || Math.max(40, Math.ceil(Math.abs(n - m) * 1.25) + 25);
  let best = runDp(normO, normR, width);
  while (best.cost === Infinity && width <= Math.max(n, m)) {
    width *= 2;
    best = runDp(normO, normR, width);
  }

  const rows = [];
  const droppedOld = [];
  let splits = 0;
  let merges = 0;
  let i = 0;
  let j = 0;
  const oldRef = (idx) => ({
    index: oldCues[idx].index,
    text: oldCues[idx].text,
    start: oldCues[idx].start,
    end: oldCues[idx].end,
  });
  const push = (row) => {
    row.id = rows.length + 1;
    rows.push(row);
  };

  for (const op of best.ops) {
    if (op === OP_PAIR) {
      push({
        revIdx: j,
        text: revLines[j],
        start: oldCues[i].start,
        end: oldCues[i].end,
        sim: similarity(normO[i], normR[j]),
        oldRefs: [oldRef(i)],
        flags: [],
      });
      i += 1;
      j += 1;
    } else if (op === OP_SPLIT) {
      const [[s1, e1], [s2, e2]] = splitRange(
        oldCues[i].start,
        oldCues[i].end,
        normR[j],
        normR[j + 1]
      );
      const sim = similarity(normO[i], normR[j] + normR[j + 1]);
      push({ revIdx: j, text: revLines[j], start: s1, end: e1, sim, oldRefs: [oldRef(i)], flags: [] });
      push({ revIdx: j + 1, text: revLines[j + 1], start: s2, end: e2, sim, oldRefs: [oldRef(i)], flags: [] });
      splits += 1;
      i += 1;
      j += 2;
    } else if (op === OP_MERGE) {
      push({
        revIdx: j,
        text: revLines[j],
        start: oldCues[i].start,
        end: oldCues[i + 1].end,
        sim: similarity(normO[i] + normO[i + 1], normR[j]),
        oldRefs: [oldRef(i), oldRef(i + 1)],
        flags: [],
      });
      merges += 1;
      i += 2;
      j += 1;
    } else if (op === OP_SKIP_OLD) {
      droppedOld.push(oldRef(i));
      i += 1;
    } else if (op === OP_SKIP_REV) {
      push({ revIdx: j, text: revLines[j], start: null, end: null, sim: 0, oldRefs: [], flags: ['unmatched'] });
      j += 1;
    }
  }

  interpolateUnmatched(rows);
  flagRows(rows);

  const pending = rows.filter((r) => r.flags.length > 0).length;
  return {
    rows,
    droppedOld,
    stats: {
      oldCount: n,
      revisedCount: m,
      rowCount: rows.length,
      ok: rows.length - pending,
      pending,
      splits,
      merges,
      dropped: droppedOld.length,
    },
  };
}

module.exports = {
  alignRevised,
  normalizeText,
  similarity,
  splitRange,
  flagRows,
  UNCERTAIN_SIM,
};
