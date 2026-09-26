'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCutPoints, avoidCuts, crossesCut, CutParseError } = require('../src/cutpoints');
const { MIN_LINE_MS, GAP_MS } = require('../src/evenize');

const row = (start, end, locked) => ({ start, end, locked: !!locked });

/** 校验结果：未锁定行满足最小时长/间隔/不跨切点，锁定行时码不变。 */
function assertAvoided(rows, cuts, lockedSnapshot) {
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if (r.locked) {
      assert.equal(r.start, lockedSnapshot[k].start, `第 ${k + 1} 行（锁定）开始被改动`);
      assert.equal(r.end, lockedSnapshot[k].end, `第 ${k + 1} 行（锁定）结束被改动`);
      continue;
    }
    assert.ok(r.end - r.start >= MIN_LINE_MS, `第 ${k + 1} 行时长不足 ${MIN_LINE_MS}ms`);
    assert.equal(crossesCut(r.start, r.end, cuts), null, `第 ${k + 1} 行仍跨越切点`);
    if (k > 0) {
      assert.ok(
        r.start - rows[k - 1].end >= GAP_MS,
        `第 ${k} 行与第 ${k + 1} 行间隔不足 ${GAP_MS}ms`
      );
    }
  }
}

test('parseCutPoints: 解析、空行忽略、排序去重', () => {
  assert.deepEqual(parseCutPoints('00:01:23,456'), [83456]);
  assert.deepEqual(parseCutPoints('01:02:03,000\n00:00:10,500'), [10500, 3723000]);
  assert.deepEqual(parseCutPoints('\n00:00:05,000\n\n00:00:05,000\n'), [5000]);
  assert.deepEqual(parseCutPoints('00:00:01.5'), [1500]); // 分隔符可用 .，毫秒可 1 位
  assert.deepEqual(parseCutPoints('  00:00:02,000  '), [2000]); // 行首尾空白容忍
});

test('parseCutPoints: 格式错误指出输入行号', () => {
  assert.throws(() => parseCutPoints('hello'), (err) => {
    assert.ok(err instanceof CutParseError);
    assert.equal(err.line, 1);
    assert.match(err.message, /第 1 行/);
    return true;
  });
  assert.throws(() => parseCutPoints('00:01:00,000\n12:34\n'), (err) => {
    assert.equal(err.line, 2);
    assert.match(err.message, /第 2 行/);
    return true;
  });
  assert.throws(() => parseCutPoints('00:61:00,000'), /第 1 行/); // 分钟超界
  assert.throws(() => parseCutPoints('00:00:60,000'), /第 1 行/); // 秒超界
});

test('avoidCuts: 单行跨切点，选总改动最小的方案（切点前结束）', () => {
  const rows = [row(1000, 3000)];
  const rep = avoidCuts(rows, [2500]);
  assert.deepEqual(rep.failures, []);
  assert.deepEqual(rep.adjusted, [1]);
  assert.deepEqual([rows[0].start, rows[0].end], [1000, 2500]); // A 代价 500 < B 代价 1500
});

test('avoidCuts: 切点靠近行首时选切点后开始', () => {
  const rows = [row(1000, 5000)];
  const rep = avoidCuts(rows, [1400]);
  assert.deepEqual(rep.failures, []);
  assert.deepEqual([rows[0].start, rows[0].end], [1400, 5000]); // B 代价 400 < A 代价 3600
});

test('avoidCuts: 时长不足 400ms 时另一端同步延伸', () => {
  const rows = [row(2300, 2600)];
  const rep = avoidCuts(rows, [2500]);
  assert.deepEqual(rep.failures, []);
  // A：end 收到 2500 后只剩 200ms，start 提前到 2100 凑足 400ms（代价 300 < B 代价 500）
  assert.deepEqual([rows[0].start, rows[0].end], [2100, 2500]);
  assertAvoided(rows, [2500], [rows[0]]);
});

test('avoidCuts: 两侧都凑不出不跨切点的 400ms 时保留原时码并报告行号与原因', () => {
  const rows = [row(2300, 2600)];
  const cuts = [2101, 2500, 2899]; // A 会跨 2101，B 会跨 2899
  const rep = avoidCuts(rows, cuts);
  assert.equal(rep.adjusted.length, 0);
  assert.equal(rep.failures.length, 1);
  assert.deepEqual(rep.failures[0].rows, [1]);
  assert.match(rep.failures[0].reason, /第 1 行/);
  assert.deepEqual([rows[0].start, rows[0].end], [2300, 2600]); // 原时码不动
});

test('avoidCuts: 单行最优被相邻行牵制时联合改选次优方案', () => {
  // 行2 单行最优是 B（start=2500，代价 400），但与行3 间隔只剩 50ms，不可行；
  // 联合选择后应改选 A（end=2500，代价 500）。
  const rows = [row(1000, 2000), row(2100, 3000), row(3050, 4000)];
  const cuts = [2500];
  const rep = avoidCuts(rows, cuts);
  assert.deepEqual(rep.failures, []);
  assert.deepEqual([rows[1].start, rows[1].end], [2100, 2500]);
  assertAvoided(rows, cuts, rows.map((r) => ({ ...r })));
});

test('avoidCuts: 锁定行时码不变，且作为边界牵制邻行方案', () => {
  const rows = [row(0, 1000, true), row(1050, 2000)];
  const cuts = [1500];
  const snapshot = rows.map((r) => ({ ...r }));
  const rep = avoidCuts(rows, cuts);
  assert.deepEqual(rep.failures, []);
  // A（end=1500, start=1050）与锁定行间隔仅 50ms 被排除，只能选 B
  assert.deepEqual([rows[1].start, rows[1].end], [1500, 2000]);
  assertAvoided(rows, cuts, snapshot);
});

test('avoidCuts: 被锁定行夹死时保留原时码并报告', () => {
  const rows = [row(0, 1000, true), row(1050, 1300), row(1650, 2000, true)];
  const cuts = [1200];
  const rep = avoidCuts(rows, cuts);
  assert.equal(rep.adjusted.length, 0);
  assert.equal(rep.failures.length, 1);
  assert.deepEqual(rep.failures[0].rows, [2]);
  assert.match(rep.failures[0].reason, /锁定行/);
  assert.deepEqual([rows[1].start, rows[1].end], [1050, 1300]);
});

test('avoidCuts: 段内无跨切点行时不动', () => {
  const rows = [row(1000, 2000), row(3000, 4000)];
  const rep = avoidCuts(rows, [5000, 2500]); // 乱序输入也能处理
  assert.deepEqual(rep.adjusted, []);
  assert.deepEqual(rep.failures, []);
  assert.deepEqual([rows[0].start, rows[0].end], [1000, 2000]);
  assert.deepEqual([rows[1].start, rows[1].end], [3000, 4000]);
});

test('avoidCuts: 跨多个切点的行归位到某一侧', () => {
  const rows = [row(1000, 5000)];
  const cuts = [2000, 4000];
  const rep = avoidCuts(rows, cuts);
  assert.deepEqual(rep.failures, []);
  // A(2000) 与 B(4000) 代价相同（3000），按切点顺序优先前者
  assert.deepEqual([rows[0].start, rows[0].end], [1000, 2000]);
  assertAvoided(rows, cuts, [rows[0]]);
});

test('avoidCuts: 相邻两跨切点行联合选择总改动最小的组合', () => {
  // 行1 跨 2500：A 代价 100 / B 代价 1800；行2 跨 5000：A 代价 100 / B 代价 2600。
  // 行1B 与行2A 组合间隔不足（2900 > 2700），全局最优为 A+A（总代价 200）。
  const rows = [row(1000, 2600), row(2700, 5100)];
  const cuts = [2500, 5000];
  const rep = avoidCuts(rows, cuts);
  assert.deepEqual(rep.failures, []);
  assert.deepEqual(rep.adjusted, [1, 2]);
  assert.deepEqual([rows[0].start, rows[0].end], [1000, 2500]);
  assert.deepEqual([rows[1].start, rows[1].end], [2700, 5000]);
  assertAvoided(rows, cuts, rows.map((r) => ({ ...r })));
});

test('avoidCuts: 多段分别处理，锁定行之间互不影响', () => {
  const rows = [
    row(1000, 3000), // 跨 2500 → A：end=2500
    row(5000, 6000, true), // 锁定不动
    row(7000, 9000), // 跨 8000 → A 代价 1000（end=8000）/ B 代价 1000（start=8000），先 A
  ];
  const cuts = [2500, 8000];
  const snapshot = rows.map((r) => ({ ...r }));
  const rep = avoidCuts(rows, cuts);
  assert.deepEqual(rep.failures, []);
  assert.deepEqual(rep.adjusted, [1, 3]);
  assert.deepEqual([rows[0].start, rows[0].end], [1000, 2500]);
  assert.deepEqual([rows[1].start, rows[1].end], [5000, 6000]);
  assert.deepEqual([rows[2].start, rows[2].end], [7000, 8000]);
  assertAvoided(rows, cuts, snapshot);
});

test('avoidCuts: 端点恰好落在切点上不算跨越，无需调整', () => {
  const rows = [row(1000, 2000), row(2100, 3000)];
  const rep = avoidCuts(rows, [2000, 2100]);
  assert.deepEqual(rep.adjusted, []);
  assert.deepEqual(rep.failures, []);
});

test('avoidCuts: 倒序或无效时码直接报错', () => {
  assert.throws(() => avoidCuts([row(3000, 2000)], [2500]), /第 1 行/);
  assert.throws(() => avoidCuts([row(NaN, 2000)], [2500]), /第 1 行/);
});
