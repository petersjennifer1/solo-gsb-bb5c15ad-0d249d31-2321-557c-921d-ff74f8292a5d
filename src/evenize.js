'use strict';

/**
 * 区间匀时引擎。
 *
 * 每行可切换「时码锁定」。点击匀时后，对每段连续未锁定行重排时码：
 *   - 左边界：前一锁定行的结束（+ 行间隔）；没有则沿用该段原首行开始；
 *   - 右边界：后一锁定行的开始（- 行间隔）；没有则沿用该段原末行结束；
 *   - 仅重排未锁定行，按「去除字幕标记后的可见字符数」加权分配时长；
 *   - 单行至少 MIN_LINE_MS，相邻行之间至少 GAP_MS，保持原顺序；
 *   - 区间容量不足以容纳最短时长时，整段保留原时码并上报（行号、所需/可用时长），
 *     其他可行区间照常更新。
 *
 * 行号一律以 1 起的输出序号（与校订页表格一致）给出。
 */

const MIN_LINE_MS = 400; // 单行最小时长
const GAP_MS = 100; // 相邻行（含与锁定行之间）最小间隔

/**
 * 去除字幕标记后的可见字符数。
 * 剥除 <i>…</i> 等标签与 {\an8} 类覆盖标签，不计空白字符；
 * 与 src/align.js 的 normalizeText 相比，这里保留中英文字与标点（标点也是需要显示的内容）。
 */
function visibleLength(text) {
  const cleaned = String(text == null ? '' : text)
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^}]*\}/g, '');
  let n = 0;
  for (const ch of cleaned) {
    if (!/\s/.test(ch)) n += 1;
  }
  return n;
}

/**
 * 把 extra 毫秒按权重 w 分配到 n 个桶，结果均为非负整数、总和恰为 extra。
 * 先按比例取整，余数用最大余数法分给权重最大的桶，保证整数时长总和精确。
 */
function distributeExtra(weights, extra) {
  const n = weights.length;
  const out = new Array(n).fill(0);
  if (extra <= 0) return out;
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // 没有可见字符可作依据：把余量均摊（余数分给靠前的行）
    const q = Math.floor(extra / n);
    let rem = extra - q * n;
    for (let k = 0; k < n; k++) {
      out[k] = q + (rem > 0 ? 1 : 0);
      rem -= 1;
    }
    return out;
  }
  const remainders = [];
  let used = 0;
  for (let k = 0; k < n; k++) {
    const exact = (extra * weights[k]) / total;
    const base = Math.floor(exact);
    out[k] = base;
    used += base;
    remainders.push({ k, r: exact - base, w: weights[k] });
  }
  let rem = extra - used;
  // 余数大者先得；并列时权重（可见字数）大者优先，再并列靠前的行优先
  remainders.sort((a, b) => b.r - a.r || b.w - a.w || a.k - b.k);
  for (let t = 0; t < rem; t++) out[remainders[t % remainders.length].k] += 1;
  return out;
}

/**
 * 主入口。
 * @param {Array<{start:number,end:number,text:string,locked?:boolean}>} rows
 * @returns {{updated:number, updatedRows:number, failures:Array<{from:number,to:number,required:number,available:number,prevLocked:number|null,nextLocked:number|null}>}}
 * 更新直接写入 rows 中未锁定行的 start/end（失败段不动）；锁定行永不修改。
 */
function evenize(rows) {
  const result = { updated: 0, updatedRows: 0, failures: [] };
  if (!Array.isArray(rows)) return result;

  const n = rows.length;
  let k = 0;
  while (k < n) {
    if (rows[k].locked) {
      k += 1;
      continue;
    }
    const from = k;
    while (k < n && !rows[k].locked) k += 1;
    const to = k; // 半开区间 [from, to)

    for (let t = from; t < to; t++) {
      const r = rows[t];
      if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) {
        throw new Error(`第 ${t + 1} 行时码无效`);
      }
      if (r.end <= r.start) {
        throw new Error(`第 ${t + 1} 行时码倒序，请先修正`);
      }
    }

    const prevLocked = from > 0 ? from - 1 : null;
    const nextLocked = to < n ? to : null;
    const count = to - from;

    // 无锁定邻居时沿用该段原首行开始 / 原末行结束
    const lo = prevLocked != null ? rows[prevLocked].end + GAP_MS : rows[from].start;
    const hi = nextLocked != null ? rows[nextLocked].start - GAP_MS : rows[to - 1].end;
    const window = hi - lo;
    const required = count * MIN_LINE_MS + (count - 1) * GAP_MS;

    if (window < required) {
      // 容量不足：整段保留原时码，交前端提示
      result.failures.push({
        from: from + 1,
        to: to,
        required,
        available: Math.max(0, window),
        prevLocked: prevLocked != null ? prevLocked + 1 : null,
        nextLocked: nextLocked != null ? nextLocked + 1 : null,
      });
      continue;
    }

    const weights = [];
    for (let t = from; t < to; t++) weights.push(Math.max(1, visibleLength(rows[t].text)));
    const extra = window - count * MIN_LINE_MS - (count - 1) * GAP_MS;
    const add = distributeExtra(weights, extra);

    // 取整后复核一次（防御性）；不满足则按容量不足处理且不动原时码
    const totalDur = add.reduce((a, b) => a + b, 0) + count * MIN_LINE_MS;
    if (totalDur + (count - 1) * GAP_MS > window) {
      result.failures.push({
        from: from + 1,
        to: to,
        required,
        available: Math.max(0, window),
        prevLocked: prevLocked != null ? prevLocked + 1 : null,
        nextLocked: nextLocked != null ? nextLocked + 1 : null,
      });
      continue;
    }

    let cursor = lo;
    for (let t = from; t < to; t++) {
      const dur = MIN_LINE_MS + add[t - from];
      rows[t].start = cursor;
      rows[t].end = cursor + dur;
      cursor += dur + GAP_MS;
    }
    result.updated += 1;
    result.updatedRows += count;
  }

  return result;
}

module.exports = { evenize, visibleLength, distributeExtra, MIN_LINE_MS, GAP_MS };
