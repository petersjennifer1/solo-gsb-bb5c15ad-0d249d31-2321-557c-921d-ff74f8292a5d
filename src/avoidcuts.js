'use strict';

/**
 * 避切点引擎。
 *
 * 输入若干镜头切点（毫秒），对**跨越切点的未锁定字幕**（start < cut < end）选择调整方案：
 *   - 在切点前结束（保留原开始，结束收到切点）；
 *   - 从切点后开始（保留原结束，开始推到切点）；
 *   - 多切点时也可整体落进两个切点之间（两端贴切点的缩短）；
 *   - 缩短后不足单行最小时长时，允许整行平移到切点前/后（必要时补足最小时长）。
 *
 * 相邻未锁定行的选择会互相牵制（相邻行之间至少 GAP_MS），因此对连续受影响行做联合
 * 动态规划：为每行枚举候选时段（含为让开相邻行而从切点再退让若干毫秒的变体），
 * 选择「总时码改动量」（各行 |Δstart| + |Δend| 之和）最小的可行组合。
 *
 * 硬约束：
 *   - 每行时长 >= MIN_LINE_MS（400ms）；
 *   - 相邻行间隔 >= GAP_MS（100ms，含与不动行/锁定行之间）；
 *   - 锁定行时码永不修改；
 *   - 调整后的行不再严格包含任何切点（切点恰在端点不算跨越）。
 *
 * 无可行方案的行保留原时码，并给出失败原因（行号一律 1 起）。
 */

const MIN_LINE_MS = 400; // 单行最小时长
const GAP_MS = 100; // 相邻行最小间隔
// 连锁退让以 GAP_MS 为步进即可命中“恰好错开相邻行”的约束；
// 连续受影响行异常多时放大步进兜底，避免候选数膨胀。
const BIG_RUN = 200;
const BIG_STEP = MIN_LINE_MS + GAP_MS;

/** 校验全部行的时码（锁定行同样参与切点判定，故也要校验）。 */
function validateRows(rows) {
  if (!Array.isArray(rows)) throw new Error('rows 必须是数组');
  rows.forEach((r, i) => {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0) {
      throw new Error(`第 ${i + 1} 行时码无效`);
    }
    if (r.end <= r.start) {
      throw new Error(`第 ${i + 1} 行时码倒序，请先修正`);
    }
  });
}

/** 规范化切点：取整、去重、升序。 */
function normalizeCuts(cuts) {
  if (!Array.isArray(cuts)) throw new Error('cuts 必须是数组');
  const out = [];
  for (const c of cuts) {
    const v = Number(c);
    if (!Number.isFinite(v) || v < 0) throw new Error('切点时码无效');
    out.push(Math.round(v));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** 行内（严格）包含的切点，升序。 */
function cutsInside(row, cuts) {
  return cuts.filter((c) => c > row.start && c < row.end);
}

function containsCut(ns, ne, cuts) {
  return cuts.some((c) => c > ns && c < ne);
}

const range = (max, step) => {
  const out = [0];
  for (let v = step; v <= max; v += step) out.push(v);
  return out;
};

/**
 * 为一段连续受影响行展开全部候选时段。
 *
 * 每个候选以“贴切点”为基准形（kind）：
 *   L  [s, B-y]      在切点 B 前结束，保留原开始
 *   R  [A+x, e]      从切点 A 后开始，保留原结束
 *   M  [A+x, B-y]    落在切点 A、B 之间
 *   SL [B-D-y, B-y]  整行平移到切点 B 前（时长 D，不足最短则补足）
 *   SR [A+x, A+D+x]  整行平移到切点 A 后
 * x/y 为“再退让量”，用于满足相邻变量行之间的 100ms 间隔。
 */
function expandRun(rows, run, cuts, prevFixed, nextFixed) {
  const m = run.length;
  const step = m > BIG_RUN ? BIG_STEP : GAP_MS;
  const exact = m <= BIG_RUN; // 异常长段只用栅格退让，跳过精确值

  // 段首/段尾的固定邻居边界；段内邻居是变量行，其冲突由 DP 解决
  const headLimit = prevFixed ? prevFixed.end + GAP_MS : 0;
  const tailLimit = nextFixed ? nextFixed.start - GAP_MS : Infinity;
  // 退让只需让开本段内相邻行：栅格上界用本段端点 + 连锁间隔封顶，避免无固定邻居时上界无穷
  const maxRunEnd = Math.max(...run.map((i) => rows[i].end));
  const minRunStart = Math.min(...run.map((i) => rows[i].start));
  const chain = m * (MIN_LINE_MS + GAP_MS);
  // 精确退让量所需的“对方可能贴切的边界”：全部切点 + 段首固定结束
  const boundaryEnds = cuts.concat(prevFixed ? [prevFixed.end + GAP_MS] : []);
  const boundaryStarts = cuts.concat(nextFixed ? [nextFixed.start - GAP_MS] : []);

  return run.map((i, t) => {
    const r = rows[i];
    const s = r.start;
    const e = r.end;
    const D = Math.max(e - s, MIN_LINE_MS);
    const inside = cutsInside(r, cuts);
    const isHead = t === 0;
    const isTail = t === m - 1;
    const L = isHead ? headLimit : 0;
    const R = isTail ? tailLimit : Infinity;

    // 以某切点为左边界 A 时，开始可向右退让的几何上限
    const xMaxForR = (A) => e - A - MIN_LINE_MS; // R 形：剩余时长
    const xMaxForSR = (A) => R - (A + D); // SR 形：不越过右固定边界
    // 以某切点为右边界 B 时，结束可向左退让的几何上限
    const yMaxForL = (B) => B - s - MIN_LINE_MS; // L 形
    const yMaxForSL = (B) => B - D - L; // SL 形：不越过左固定边界/时间起点
    const xMaxForM = (A, B) => B - A - MIN_LINE_MS;
    // 退让只需让开本段内相邻行，故栅格上界再被本段端点 + 连锁间隔封顶
    const xGridCap = (A) => Math.min(chain, maxRunEnd + chain - A);
    const yGridCap = (B) => Math.min(chain, B - (minRunStart - chain));

    const xSetFor = (A, xMax) => {
      xMax = Math.floor(Math.max(0, xMax));
      const set = new Set(range(Math.min(xMax, xGridCap(A)), step));
      if (exact) {
        // 精确命中“晚于某行贴切点结束 + 100ms”所需的退让量；
        // 更深的连锁退让量由 100ms 栅格（range）覆盖。
        for (const bEnd of boundaryEnds) {
          const v = bEnd + GAP_MS - A;
          if (v >= 0 && v <= xMax) set.add(v);
        }
      }
      return [...set];
    };
    const ySetFor = (B, yMax) => {
      yMax = Math.floor(Math.max(0, yMax));
      const set = new Set(range(Math.min(yMax, yGridCap(B)), step));
      if (exact) {
        // 精确命中“早于某行贴切点开始 - 100ms”所需的退让量
        for (const aStart of boundaryStarts) {
          const v = B + GAP_MS - aStart;
          if (v >= 0 && v <= yMax) set.add(v);
        }
      }
      return [...set];
    };

    const seen = new Set();
    const list = [];
    const add = (ns, ne) => {
      ns = Math.round(ns);
      ne = Math.round(ne);
      if (ns === s && ne === e) return;
      if (ne - ns < MIN_LINE_MS) return;
      if (ns < L || ne > R) return;
      if (containsCut(ns, ne, cuts)) return;
      const key = `${ns}:${ne}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ start: ns, end: ne, cost: Math.abs(ns - s) + Math.abs(ne - e) });
    };

    const emitShapes = (A, B, middle) => {
      // A/B 为该无切点区间的左右切点（middle=false 时外侧为 null）
      if (!middle) {
        if (A == null) {
          // 最左区间：L 形 + SL 形（平移救援）
          for (const y of ySetFor(B, yMaxForL(B))) add(s, B - y);
          for (const y of ySetFor(B, yMaxForSL(B))) add(B - D - y, B - y);
        } else {
          // 最右区间：R 形 + SR 形
          for (const x of xSetFor(A, xMaxForR(A))) add(A + x, e);
          for (const x of xSetFor(A, xMaxForSR(A))) add(A + x, A + D + x);
        }
      } else {
        // 中间区间：M 形（两端贴切点；区间放不下原时长时平移本就不可能，故无平移形）
        const cap = xMaxForM(A, B);
        if (cap < 0) return;
        for (const x of xSetFor(A, cap)) {
          for (const y of ySetFor(B, cap - x)) {
            add(A + x, B - y);
          }
        }
      }
    };

    if (inside.length === 1) {
      emitShapes(null, inside[0], false);
      emitShapes(inside[0], null, false);
    } else {
      emitShapes(null, inside[0], false);
      for (let z = 0; z + 1 < inside.length; z++) emitShapes(inside[z], inside[z + 1], true);
      emitShapes(inside[inside.length - 1], null, false);
    }

    list.sort((a, b) => a.cost - b.cost || a.start - b.start);
    return list;
  });
}

/**
 * 在允许“从切点再退让”的前提下，判断行在固定边界 [L, R] 内的三类落位是否可行。
 * 与 expandRun 枚举的候选形一致：切前侧（L 形缩短 / SL 形平移）、
 * 切后侧（R 形缩短 / SR 形平移）、中间区间（M 形缩短）。
 */
function familyFeasibility(row, inside, L, R) {
  const s = row.start;
  const e = row.end;
  const D = Math.max(e - s, MIN_LINE_MS);
  const cLo = inside[0];
  const cHi = inside[inside.length - 1];

  // 切前侧：退让后结束位置最高只能到 min(cLo, R)
  const leftFloor = Math.min(cLo, R);
  const leftTrim = s >= L && leftFloor - s >= MIN_LINE_MS;
  const leftShift = leftFloor - L >= D;
  // 切后侧：退让后开始位置最低也要 max(cHi, L)
  const rightCeil = Math.max(cHi, L);
  const rightTrim = e <= R && e - rightCeil >= MIN_LINE_MS;
  const rightShift = R - rightCeil >= D;
  // 中间区间
  const middle = [];
  for (let z = 0; z + 1 < inside.length; z++) {
    const A = inside[z];
    const B = inside[z + 1];
    if (Math.min(B, R) - Math.max(A, L) >= MIN_LINE_MS) middle.push([A, B]);
  }
  return { left: leftTrim || leftShift, right: rightTrim || rightShift, middle, leftTrim, leftShift, rightTrim, rightShift };
}

/** 无候选时给出具体原因（L/R 与 expandRun 对该行使用的固定边界一致）。 */
function noCandidateReason(row, inside, L, R, prevFixed, nextFixed) {
  const f = familyFeasibility(row, inside, L, R);
  const why = [];
  if (!f.left) {
    why.push(
      `切点前侧放不下 ${MIN_LINE_MS}ms 时段` +
        (prevFixed ? `（第 ${prevFixed.idx + 1} 行结束于 ${prevFixed.end}，需另留 ${GAP_MS}ms 间隔）` : `（时间起点到切点仅 ${inside[0]}ms）`)
    );
  }
  if (!f.right) {
    why.push(
      nextFixed
        ? `切点后侧到第 ${nextFixed.idx + 1} 行放不下 ${MIN_LINE_MS}ms 时段（需另留 ${GAP_MS}ms 间隔）`
        : `切点后侧放不下 ${MIN_LINE_MS}ms 时段`
    );
  }
  if (!f.left && !f.right && !f.middle.length && inside.length > 1) {
    why.push(`相邻切点之间的间隔均不足 ${MIN_LINE_MS}ms`);
  }
  if (!why.length) why.push('相邻行牵制，无满足时长与间隔约束的方案');
  return `无可行方案：${why.join('；')}，已保留原时码`;
}

/**
 * 主入口。直接修改 rows 中可调整行的 start/end；失败行与锁定行不动。
 * @param {Array<{start:number,end:number,text?:string,locked?:boolean}>} rows
 * @param {number[]} cutsInput
 * @returns {{updated:number, failures:Array<{line:number,reason:string}>, spanning:number[]}}
 */
function avoidCuts(rows, cutsInput) {
  validateRows(rows);
  const cuts = normalizeCuts(cutsInput);
  const n = rows.length;
  const result = { updated: 0, failures: [], spanning: [] };
  if (!cuts.length) return result;

  const locked = rows.map((r) => !!r.locked);
  const insideOf = (i) => cutsInside(rows[i], cuts);

  // 失败行（先收录锁定但跨切点的行）：下标 -> 原因
  const failures = new Map();
  for (let i = 0; i < n; i++) {
    if (locked[i]) {
      const cs = insideOf(i);
      if (cs.length) failures.set(i, `该行已锁定，时码保持不变，仍跨越 ${cs.length} 个切点`);
    }
  }

  const isVariable = (i) => !locked[i] && !failures.has(i) && insideOf(i).length > 0;

  // 连续变量行段（段间至少隔一行固定行）；零候选行被剔除后子段重新入队
  const runs = [];
  for (let i = 0; i < n; i++) {
    if (!isVariable(i)) continue;
    let j = i;
    const run = [i];
    while (j + 1 < n && isVariable(j + 1)) {
      j += 1;
      run.push(j);
    }
    runs.push(run);
    i = j;
  }

  for (let qi = 0; qi < runs.length; qi++) {
    const run = runs[qi];
    const head = run[0];
    const tail = run[run.length - 1];
    const prevFixed = head > 0 && !isVariable(head - 1) ? { ...rows[head - 1], idx: head - 1 } : null;
    const nextFixed = tail + 1 < n && !isVariable(tail + 1) ? { ...rows[tail + 1], idx: tail + 1 } : null;
    const L = prevFixed ? prevFixed.end + GAP_MS : 0;
    const R = nextFixed ? nextFixed.start - GAP_MS : Infinity;

    // 展开候选后，对零候选行判失败（原时码成为邻居的固定边界，子段重算）。
    // 段首/段尾才贴着固定行；段内行边界为 [0, +∞)，变量邻居冲突交给 DP。
    const cand = expandRun(rows, run, cuts, prevFixed, nextFixed);
    const boundsAt = (t) => ({
      L: t === 0 ? L : 0,
      R: t === run.length - 1 ? R : Infinity,
      pf: t === 0 ? prevFixed : null,
      nf: t === run.length - 1 ? nextFixed : null,
    });
    const deadT = cand.findIndex((list) => list.length === 0);
    if (deadT !== -1) {
      const i = run[deadT];
      const b = boundsAt(deadT);
      failures.set(i, noCandidateReason(rows[i], insideOf(i), b.L, b.R, b.pf, b.nf));
      const left = run.slice(0, deadT);
      const right = run.slice(deadT + 1);
      if (left.length) runs.push(left);
      if (right.length) runs.push(right);
      continue;
    }

    // DP：dp[j] = 当前行选第 j 个候选时的最小累计改动
    let dp = cand[0].map((c) => ({ cost: c.cost, from: -1 }));
    const layers = [dp];
    for (let t = 1; t < run.length; t++) {
      const layer = new Array(cand[t].length);
      for (let j = 0; j < cand[t].length; j++) {
        let best = Infinity;
        let from = -1;
        for (let k = 0; k < cand[t - 1].length; k++) {
          if (dp[k].cost === Infinity) continue;
          if (cand[t][j].start < cand[t - 1][k].end + GAP_MS) continue;
          const total = dp[k].cost + cand[t][j].cost;
          if (total < best) {
            best = total;
            from = k;
          }
        }
        layer[j] = { cost: best, from };
      }
      dp = layer;
      layers.push(layer);
    }

    let pick = -1;
    let best = Infinity;
    dp.forEach((d, j) => {
      if (d.cost < best) {
        best = d.cost;
        pick = j;
      }
    });
    if (pick === -1) {
      // 联合无解：整段保留原时码
      const fromLine = run[0] + 1;
      const toLine = run[run.length - 1] + 1;
      const rangeTxt = fromLine === toLine ? `第 ${fromLine} 行` : `第 ${fromLine}–${toLine} 行`;
      for (const i of run) {
        failures.set(
          i,
          `无可行方案：${rangeTxt}相邻牵制，无法同时满足单行 ≥ ${MIN_LINE_MS}ms、行间 ≥ ${GAP_MS}ms 且不跨越切点，已保留原时码`
        );
      }
      continue;
    }

    const chosen = new Array(run.length);
    for (let t = run.length - 1; t >= 0; t--) {
      chosen[t] = pick;
      pick = layers[t][pick].from;
    }
    run.forEach((i, t) => {
      rows[i].start = cand[t][chosen[t]].start;
      rows[i].end = cand[t][chosen[t]].end;
      result.updated += 1;
    });
  }

  result.failures = [...failures.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, reason]) => ({ line: i + 1, reason }));

  rows.forEach((r, i) => {
    if (cutsInside(r, cuts).length) result.spanning.push(i + 1);
  });
  return result;
}

module.exports = { avoidCuts, cutsInside, MIN_LINE_MS, GAP_MS };
