'use strict';

/**
 * 镜头切点避切引擎。
 *
 * 输入镜头切点（每行一个 HH:MM:SS,mmm），把跨越切点的未锁定行挪到切点一侧：
 *   - 方案 A「切点前结束」：end 收到切点；若剩余时长不足 MIN_LINE_MS，start 同步提前；
 *   - 方案 B「切点后开始」：start 推到切点；若剩余时长不足 MIN_LINE_MS，end 同步推后。
 * 同一段连续未锁定行内，多个跨切点行会与相邻行相互牵制（行间至少 GAP_MS），
 * 故用链式动态规划联合选择「总时码改动 Σ(|Δstart|+|Δend|) 最小」的方案组合。
 *
 * 约束：每行 ≥ MIN_LINE_MS、相邻行（含与锁定邻居）间隔 ≥ GAP_MS、锁定行不动、
 * 调整后任何行不再跨越切点（端点恰好落在切点上不算跨越）。
 * 某段无可行组合时整段保留原时码，并上报跨切点行号与原因。
 *
 * 行号一律以 1 起的输出序号（与校订页表格一致）给出。
 */

const { MIN_LINE_MS, GAP_MS } = require('./evenize');

const CUT_RE = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

/** 切点格式错误：携带 1 起的输入行号。 */
class CutParseError extends Error {
  constructor(line, text) {
    super(`第 ${line} 行切点格式错误：「${text}」，应为 HH:MM:SS,mmm（如 00:01:23,456）`);
    this.name = 'CutParseError';
    this.line = line;
  }
}

/**
 * 解析切点文本：每行一个 HH:MM:SS,mmm（毫秒 1–3 位，分隔符 , 或 .；空行忽略）。
 * 返回升序去重后的毫秒数组；格式错误抛 CutParseError（含输入行号）。
 */
function parseCutPoints(text) {
  const cuts = [];
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (let k = 0; k < lines.length; k++) {
    const raw = lines[k].trim();
    if (!raw) continue;
    const m = raw.match(CUT_RE);
    if (!m || Number(m[2]) >= 60 || Number(m[3]) >= 60) {
      throw new CutParseError(k + 1, raw);
    }
    cuts.push(
      Number(m[1]) * 3600000 +
        Number(m[2]) * 60000 +
        Number(m[3]) * 1000 +
        Number(m[4].padEnd(3, '0').slice(0, 3))
    );
  }
  cuts.sort((a, b) => a - b);
  return [...new Set(cuts)];
}

/** 行是否严格跨越某切点：start < cut < end（端点落在切点上不算）。返回第一个被跨越的切点或 null。 */
function crossesCut(start, end, cuts) {
  for (const c of cuts) {
    if (start < c && c < end) return c;
  }
  return null;
}

/**
 * 为跨切点行生成候选方案：对每个被跨越的切点给出 A（切点前结束）/ B（切点后开始）两个动作。
 * 只保留「不跨任何切点、start ≥ 0」的动作；时长由构造保证 ≥ MIN_LINE_MS。
 */
function actionsFor(row, cuts) {
  const acts = [];
  const seen = new Set();
  const push = (start, end) => {
    const key = start + ':' + end;
    if (seen.has(key)) return;
    seen.add(key);
    acts.push({ start, end });
  };
  for (const c of cuts) {
    if (!(row.start < c && c < row.end)) continue;
    // A：切点前结束（start 尽量不动，不足 MIN_LINE_MS 时提前）
    const aStart = Math.min(row.start, c - MIN_LINE_MS);
    if (aStart >= 0 && crossesCut(aStart, c, cuts) == null) push(aStart, c);
    // B：切点后开始（end 尽量不动，不足 MIN_LINE_MS 时推后）
    const bEnd = Math.max(row.end, c + MIN_LINE_MS);
    if (crossesCut(c, bEnd, cuts) == null) push(c, bEnd);
  }
  return acts;
}

/**
 * 段内联合求解：链式 DP，状态为每行的候选动作，相邻动作间隔须 ≥ GAP_MS。
 * 返回 { chosen }；某行无候选动作返回 { infeasibleRow, boundary }；组合无解返回 null。
 */
function solveSegment(rows, from, to, cuts, prevLocked, nextLocked) {
  const n = to - from;
  const allActs = [];
  for (let t = from; t < to; t++) {
    const r = rows[t];
    let acts;
    if (crossesCut(r.start, r.end, cuts) == null) {
      acts = [{ start: r.start, end: r.end, keep: true }];
    } else {
      acts = actionsFor(r, cuts);
      if (!acts.length) return { infeasibleRow: t, boundary: false };
    }
    // 段边界：与锁定邻居之间也要留出 GAP_MS
    if (t === from && prevLocked != null) {
      acts = acts.filter((a) => a.start >= rows[prevLocked].end + GAP_MS);
    }
    if (t === to - 1 && nextLocked != null) {
      acts = acts.filter((a) => a.end <= rows[nextLocked].start - GAP_MS);
    }
    if (!acts.length) return { infeasibleRow: t, boundary: true };
    allActs.push(
      acts.map((a) => ({
        ...a,
        cost: Math.abs(a.start - r.start) + Math.abs(a.end - r.end),
      }))
    );
  }

  let dp = allActs[0].map((a) => a.cost);
  const parents = [allActs[0].map(() => -1)];
  for (let k = 1; k < n; k++) {
    const cur = new Array(allActs[k].length).fill(Infinity);
    const par = new Array(allActs[k].length).fill(-1);
    for (let j = 0; j < allActs[k].length; j++) {
      const a = allActs[k][j];
      let best = -1;
      for (let p = 0; p < allActs[k - 1].length; p++) {
        if (dp[p] === Infinity) continue;
        if (a.start - allActs[k - 1][p].end < GAP_MS) continue;
        if (best < 0 || dp[p] < dp[best]) best = p;
      }
      if (best >= 0) {
        cur[j] = dp[best] + a.cost;
        par[j] = best;
      }
    }
    if (cur.every((c) => c === Infinity)) return null; // 无可行组合
    dp = cur;
    parents.push(par);
  }

  let bestJ = -1;
  for (let j = 0; j < dp.length; j++) {
    if (dp[j] < Infinity && (bestJ < 0 || dp[j] < dp[bestJ])) bestJ = j;
  }
  if (bestJ < 0) return null;
  const chosen = new Array(n);
  let j = bestJ;
  for (let k = n - 1; k >= 0; k--) {
    chosen[k] = allActs[k][j];
    j = parents[k][j];
  }
  return { chosen };
}

/**
 * 主入口。
 * @param {Array<{start:number,end:number,locked?:boolean}>} rows 结果直接写入未锁定行
 * @param {number[]} cuts 毫秒切点（函数内自行排序去重）
 * @returns {{adjusted:number[], failures:Array<{rows:number[], reason:string}>}}
 * adjusted 为被改动的行号；failures 为保留原时码的跨切点行号及原因。
 */
function avoidCuts(rows, cuts) {
  const result = { adjusted: [], failures: [] };
  if (!Array.isArray(rows) || !Array.isArray(cuts)) return result;
  const sorted = [...new Set(cuts.filter((c) => Number.isFinite(c) && c >= 0))].sort((a, b) => a - b);
  if (!sorted.length) return result;

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

    const crossing = [];
    for (let t = from; t < to; t++) {
      if (crossesCut(rows[t].start, rows[t].end, sorted) != null) crossing.push(t);
    }
    if (!crossing.length) continue; // 该段没有跨切点行，原样保留

    const prevLocked = from > 0 ? from - 1 : null;
    const nextLocked = to < n ? to : null;
    const solved = solveSegment(rows, from, to, sorted, prevLocked, nextLocked);

    if (!solved || solved.infeasibleRow != null) {
      let reason;
      if (solved && solved.infeasibleRow != null) {
        reason = solved.boundary
          ? `第 ${solved.infeasibleRow + 1} 行受锁定行牵制，腾不出 ≥${MIN_LINE_MS}ms 且不跨切点的时段`
          : `第 ${solved.infeasibleRow + 1} 行在切点前后均凑不出 ≥${MIN_LINE_MS}ms 且不跨其他切点的时段`;
      } else {
        reason = `段内行相互牵制，找不到满足每行 ≥${MIN_LINE_MS}ms、相邻间隔 ≥${GAP_MS}ms 的可行组合`;
      }
      result.failures.push({ rows: crossing.map((t) => t + 1), reason });
      continue;
    }

    for (let t = from; t < to; t++) {
      const a = solved.chosen[t - from];
      const r = rows[t];
      if (!a.keep && (a.start !== r.start || a.end !== r.end)) {
        r.start = a.start;
        r.end = a.end;
        result.adjusted.push(t + 1);
      }
    }
  }
  return result;
}

module.exports = { parseCutPoints, avoidCuts, crossesCut, CutParseError };
