' strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { avoidCuts, cutsInside, MIN_LINE_MS, GAP_MS } = require('../src/avoidcuts');

const row = (start, end, locked) => ({ start, end, text: '台词', locked: !!locked });

function assertNoSpanning(rows, cuts) {
  rows.forEach((r, i) => {
    assert.equal(cutsInside(r, cuts).length, 0, `第 ${i + 1} 行仍跨越切点`);
  });
}

test('cutsInside: 切点恰在端点不算跨越', () => {
  assert.equal(cutsInside({ start: 1000, end: 2000 }, [500, 1000, 2000, 3000]).length, 0);
  assert.deepEqual(cutsInside({ start: 1000, end: 2000 }, [1500]), [1500]);
});

test('avoidCuts: 两侧均可时选总改动最小的方案（缩短到切点）', () => {
  // 切点 3000：切前缩短改动 1500，切后缩短改动 2000 → 在切点前结束
  const rows = [row(1000, 4500)];
  const rep = avoidCuts(rows, [3000]);
  assert.equal(rep.failures.length, 0);
  assert.equal(rep.updated, 1);
  assert.deepEqual([rows[0].start, rows[0].end], [1000, 3000]);

  // 切点 4000：切前缩短改动 500，切后缩短改动 3000 → 在切点前结束
  const rows2 = [row(1000, 4000)];
  avoidCuts(rows2, [3500]);
  assert.deepEqual([rows2[0].start, rows2[0].end], [1000, 3500]);

  // 切点 1500：切前缩短改动 500，切后缩短改动 500（改动相同）→ 取首个最小候选（切点前结束）
  const rows3 = [row(1000, 2000)];
  const rep3 = avoidCuts(rows3, [1500]);
  assert.equal(rep3.failures.length, 0);
  assert.deepEqual([rows3[0].start, rows3[0].end], [1000, 1500]);
});

test('avoidCuts: 缩短后不足 400ms 时整行平移到切点后侧，平移改动最小', () => {
  // 行 [1000,2700]（1700ms）跨切点 1100：
  // 切前缩短只剩 100ms（不足 400）；切后缩短到 [1100,2700] 改动 100ms 即可，优先缩短
  const rows = [row(1000, 2700)];
  avoidCuts(rows, [1100]);
  assert.deepEqual([rows[0].start, rows[0].end], [1100, 2700]);

  // 行 [2000,2700]（700ms）跨切点 2320，右邻锁定行 start=4000：
  // 切前缩短 320ms、切后缩短 380ms 均不足 400；整行右移到 [2320,3020]（改动 640）
  // 比整行左移到 [1620,2320]（改动 760）更省 → 选右移
  const rows2 = [row(2000, 2700), row(4000, 5000, true)];
  const rep = avoidCuts(rows2, [2320]);
  assert.equal(rep.failures.length, 0);
  assert.deepEqual([rows2[0].start, rows2[0].end], [2320, 3020]);
});

test('avoidCuts: 缩短可行时不平移', () => {
  // 行 [2000,6000] 跨切点 2500：切前缩短改动 3500，切后缩短改动 500；平移改动 ≥1000，不应采用
  const rows = [row(2000, 6000)];
  avoidCuts(rows, [2500]);
  assert.deepEqual([rows[0].start, rows[0].end], [2500, 6000]);
});

test('avoidCuts: 平移不越过时间起点，放不下时改用切点后侧', () => {
  // 平移到切点前需要 start=-100（不可行）；切前缩短 100ms 不足 400；切后缩短 1000ms 可行
  const rows = [row(0, 1500)];
  avoidCuts(rows, [100]);
  assert.deepEqual([rows[0].start, rows[0].end], [100, 1500]);
});

test('avoidCuts: 锁定行不动并上报失败；相邻未锁定行照常调整', () => {
  const rows = [
    row(1000, 3000, true), // 锁定但跨切点
    row(4000, 6000),
  ];
  const rep = avoidCuts(rows, [2000, 5000]);
  assert.deepEqual([rows[0].start, rows[0].end], [1000, 3000]);
  assert.equal(rep.failures.length, 1);
  assert.equal(rep.failures[0].line, 1);
  assert.match(rep.failures[0].reason, /锁定/);
  assert.deepEqual([rows[1].start, rows[1].end], [4000, 5000]);
  assert.deepEqual(rep.spanning, [1]);
});

test('avoidCuts: 两侧都放不下 400ms 的行保留原时码并给原因', () => {
  // 切点 500：切前 500ms 可用空间放不下 400ms 行（start=200）；切后时长 600ms 但右邻锁定
  const rows = [
    row(200, 1100),
    row(2000, 3000, true),
  ];
  // 切前空间 = 200~500 = 300ms；切后 500~1100 = 600ms 可行 → 调整
  const rep = avoidCuts(rows, [500]);
  assert.equal(rep.failures.length, 0);
  assert.deepEqual([rows[0].start, rows[0].end], [500, 1100]);

  // 切后被右邻（锁定，start=800）限制，切前仅 300ms → 无方案
  const rows2 = [row(200, 1100), row(800, 3000, true)];
  const rep2 = avoidCuts(rows2, [500]);
  assert.equal(rep2.updated, 0);
  assert.equal(rep2.failures.length, 1);
  assert.equal(rep2.failures[0].line, 1);
  assert.match(rep2.failures[0].reason, /第 2 行/);
  assert.deepEqual([rows2[0].start, rows2[0].end], [200, 1100]);
  assert.deepEqual(rep2.spanning, [1]);
});

test('avoidCuts: 相邻行联合选择总改动最小且满足 100ms 间隔', () => {
  // 两行都跨切点 5000：各自最便宜都是切前结束，但会重叠 → 必须一前一后
  const rows = [
    row(4500, 5200), // 切前缩短 200 <400 不可；切后缩短 500 可行
    row(4900, 5600), // 同上，切后缩短 600
  ];
  const rep = avoidCuts(rows, [5000]);
  // 第一行只能从切点后开始，两行同侧切后仍需间隔 → DP 联动
  assert.equal(rep.failures.length, 0);
  assert.ok(rows[0].end <= rows[1].start - GAP_MS || rows[1].end <= rows[0].start - GAP_MS);
  assertNoSpanning(rows, [5000]);
  rows.forEach((r) => assert.ok(r.end - r.start >= MIN_LINE_MS));
});

test('avoidCuts: 最便宜组合间隔为 0 时恰好退让 100ms 且总改动最小', () => {
  // #1 [4500,5500] 切前缩短 500 最便宜；#2 [5000,5600] 切后缩短 600 最便宜；
  // 两者贴切点后间隔为 0 → #1 再后退 100ms（总改动 600）比 #2 后推 100ms（700）更省
  const rows = [row(4500, 5500), row(5000, 5600)];
  const rep = avoidCuts(rows, [5000]);
  assert.equal(rep.failures.length, 0);
  assert.deepEqual([rows[0].start, rows[0].end], [4500, 4900]);
  assert.deepEqual([rows[1].start, rows[1].end], [5000, 5600]);
  assert.ok(rows[1].start - rows[0].end >= GAP_MS);
  assertNoSpanning(rows, [5000]);
});

test('avoidCuts: 各行独立最便宜组合冲突时选联合最小改动', () => {
  // 行 A 跨切点（切前便宜），行 B 紧随其后也跨切点：A 切前、B 切后最省且天然有间隔
  const rows = [
    row(1000, 5500), // 切前改动 500，切后改动 4500
    row(6000, 9500), // 切前改动 1000，切后改动 3500
  ];
  const cuts = [5000, 9000];
  const rep = avoidCuts(rows, cuts);
  assert.equal(rep.failures.length, 0);
  assert.deepEqual([rows[0].start, rows[0].end], [1000, 5000]);
  assert.deepEqual([rows[1].start, rows[1].end], [6000, 9000]);
  assert.ok(rows[1].start - rows[0].end >= GAP_MS);
});

test('avoidCuts: 后侧被不跨切点的相邻行挤掉时改用切点前结束', () => {
  // 行1 跨切点 5000；行2 [5200,6000] 不跨切点，为固定行：
  // 切后缩短需 end <= 5100（行2 start - 100），只剩 100ms；切前缩短 500ms 可行
  const rows = [
    row(0, 200, true),
    row(4500, 5600),
    row(5200, 6000),
    row(9000, 9200, true),
  ];
  const rep = avoidCuts(rows, [5000]);
  assert.equal(rep.failures.length, 0);
  assert.deepEqual([rows[1].start, rows[1].end], [4500, 5000]);
});

test('avoidCuts: 切点两侧时长都不足且平移亦无空间时失败', () => {
  // 左：时间起点；右：紧邻锁定行 start=700（间隔 100 → 上限 600）
  const rows = [row(100, 1100), row(700, 3000, true)];
  const rep = avoidCuts(rows, [400]);
  assert.equal(rep.updated, 0);
  assert.equal(rep.failures.length, 1);
  assert.equal(rep.failures[0].line, 1);
  assert.match(rep.failures[0].reason, /无可行方案/);
  assert.deepEqual([rows[0].start, rows[0].end], [100, 1100]);
});

test('avoidCuts: 不跨切点的行时码完全不动', () => {
  const rows = [
    row(0, 1000),
    row(5000, 6000),
    row(7000, 8000, true),
  ];
  const rep = avoidCuts(rows, [2000, 6500]);
  assert.equal(rep.updated, 0);
  assert.equal(rep.failures.length, 0);
  assert.deepEqual([rows[0].start, rows[0].end], [0, 1000]);
  assert.deepEqual([rows[1].start, rows[1].end], [5000, 6000]);
  assert.deepEqual([rows[2].start, rows[2].end], [7000, 8000]);
});

test('avoidCuts: 无切点 / 空切点不改动', () => {
  const rows = [row(1000, 5000)];
  const rep = avoidCuts(rows, []);
  assert.equal(rep.updated, 0);
  assert.deepEqual([rows[0].start, rows[0].end], [1000, 5000]);
});

test('avoidCuts: 倒序或无效时码直接报错', () => {
  assert.throws(() => avoidCuts([row(3000, 2000)], [2500]), /第 1 行/);
  assert.throws(() => avoidCuts([{ start: NaN, end: 2000 }], [1000]), /第 1 行/);
});

test('avoidCuts: 多个切点时调整结果不跨越任何切点', () => {
  // 行跨越两个切点：1500 与 3500；锚定缩短可落在中段 1500~3500（2000ms）
  const rows = [row(1000, 4000)];
  const cuts = [1500, 3500];
  const rep = avoidCuts(rows, cuts);
  assert.equal(rep.failures.length, 0);
  assert.deepEqual([rows[0].start, rows[0].end], [1500, 3500]);
  assertNoSpanning(rows, cuts);
});

test('avoidCuts: 切点去重排序，端点接触安全', () => {
  const rows = [row(1000, 5000)];
  const rep = avoidCuts(rows, [3000, 3000, 2000]);
  assert.equal(rep.failures.length, 0);
  const endAtCut = rows[0].end === 2000 || rows[0].end === 3000 || rows[0].start === 2000 || rows[0].start === 3000;
  assert.ok(endAtCut);
  assertNoSpanning(rows, [2000, 3000]);
});
