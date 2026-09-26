'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evenize, visibleLength, distributeExtra, MIN_LINE_MS, GAP_MS } = require('../src/evenize');

const row = (start, end, text, locked) => ({ start, end, text, locked: !!locked });

/** 校验一组匀时后的行：未锁定行满足最小时长、间隔、顺序与边界约束。 */
function assertLayout(rows, indices, lo, hi) {
  const seg = indices.map((i) => rows[i]);
  for (const r of seg) {
    assert.ok(r.end - r.start >= MIN_LINE_MS, `单行时长不足: ${r.end - r.start}`);
  }
  assert.equal(seg[0].start, lo, '首行开始应为左边界');
  assert.equal(seg[seg.length - 1].end, hi, '末行结束应为右边界');
  for (let k = 1; k < seg.length; k++) {
    assert.ok(seg[k].start - seg[k - 1].end >= GAP_MS, '行间间隔不足 100ms');
  }
}

test('visibleLength: 剥除标签与空白，保留中英文与标点', () => {
  assert.equal(visibleLength('<i>你好，世界！</i>'), 6); // 你好，世界！
  assert.equal(visibleLength('{\\an8}Hello\nworld'), 10);
  assert.equal(visibleLength('  \n\t '), 0);
  assert.equal(visibleLength(null), 0);
  assert.equal(visibleLength('<b>A</b> <i>B</i>'), 2);
});

test('distributeExtra: 总和精确、非负、按权重比例', () => {
  const out = distributeExtra([1, 1, 2], 1000);
  assert.equal(out.reduce((a, b) => a + b, 0), 1000);
  assert.ok(out.every((v) => v >= 0));
  assert.ok(out[2] >= out[0]); // 权重大的分得不少
  const zero = distributeExtra([0, 0, 0], 10);
  assert.deepEqual(zero, [4, 3, 3]);
});

test('evenize: 无锁定行时沿用整体原首开始/原末结束，按可见字数分配', () => {
  const rows = [
    row(1000, 2000, '短'),
    row(3000, 4000, '这是比较长的一句台词有十个字'),
    row(5000, 9000, '中等长度七七七七字'),
  ];
  const rep = evenize(rows);
  assert.equal(rep.failures.length, 0);
  assert.equal(rep.updated, 1);
  assert.equal(rep.updatedRows, 3);
  assert.equal(rows[0].start, 1000); // 沿用原首行开始
  assert.equal(rows[2].end, 9000); // 沿用原末行结束
  assertLayout(rows, [0, 1, 2], 1000, 9000);
  const lens = rows.map((r) => r.end - r.start);
  assert.ok(lens[1] > lens[0], '字数多的行应分到更长时长');
});

test('evenize: 锁定行为边界，锁定行不变，未锁定行被重排', () => {
  const rows = [
    row(0, 1000, '锁定首行', true),
    row(2000, 3000, '第一句'),
    row(4000, 5000, '第二句加长加长加长'),
    row(8000, 9000, '锁定末行', true),
  ];
  const rep = evenize(rows);
  assert.equal(rep.failures.length, 0);
  assert.deepEqual([rows[0].start, rows[0].end], [0, 1000]);
  assert.deepEqual([rows[3].start, rows[3].end], [8000, 9000]);
  assertLayout(rows, [1, 2], 1000 + GAP_MS, 8000 - GAP_MS);
  assert.ok(rows[1].start >= rows[0].end + GAP_MS);
  assert.ok(rows[3].start >= rows[2].end + GAP_MS);
});

test('evenize: 容量不足的区间保留原时码并上报所需/可用时长，其他区间照常更新', () => {
  const rows = [
    row(0, 500, '锁', true), // 与下一锁定行之间只留 1000ms，放不下 3 行
    row(1000, 1100, '甲'),
    row(1100, 1200, '乙'),
    row(1200, 1300, '丙'),
    row(1500, 1600, '锁', true),
    row(2000, 2100, '另一段一'),
    row(5000, 5100, '另一段二'),
  ];
  const backup = rows.map((r) => ({ ...r }));
  const rep = evenize(rows);
  assert.equal(rep.failures.length, 1);
  const f = rep.failures[0];
  assert.deepEqual([f.from, f.to], [2, 4]);
  assert.equal(f.required, 3 * MIN_LINE_MS + 2 * GAP_MS); // 1400
  assert.equal(f.available, 1500 - GAP_MS - (500 + GAP_MS)); // 800
  // 失败段原时码不动
  for (let i = 1; i <= 3; i++) {
    assert.equal(rows[i].start, backup[i].start);
    assert.equal(rows[i].end, backup[i].end);
  }
  // 另一可行区间（有前置锁定邻居、无后锁定邻居）仍更新
  assert.equal(rep.updated, 1);
  assert.equal(rep.updatedRows, 2);
  assert.equal(rows[5].start, 1600 + GAP_MS); // 前一锁定行结束 + 100
  assert.equal(rows[6].end, 5100); // 沿用该段原末行结束
  assert.ok(rows[6].start - rows[5].end >= GAP_MS);
});

test('evenize: 多个未锁定段分别处理，互不影响且不越过锁定行', () => {
  const rows = [
    row(0, 1000, '段一甲甲甲'),
    row(5000, 6000, '段一乙乙乙'),
    row(7000, 8000, '中锁', true),
    row(9000, 10000, '段二甲甲甲'),
    row(20000, 21000, '段二乙乙乙'),
  ];
  const rep = evenize(rows);
  assert.equal(rep.failures.length, 0);
  assert.equal(rep.updated, 2);
  assertLayout(rows, [0, 1], 0, 6900); // 右边界 = 锁定行开始 7000 - 100
  assert.ok(rows[1].end <= rows[2].start - GAP_MS);
  assertLayout(rows, [3, 4], 8100, 21000); // 左边界 = 锁定行结束 8000 + 100
  assert.ok(rows[3].start >= rows[2].end + GAP_MS);
  assert.deepEqual([rows[2].start, rows[2].end], [7000, 8000]);
});

test('evenize: 两个锁定行之间仅一行时，至少 400ms 且两侧留 100ms', () => {
  const rows = [
    row(0, 2000, '锁', true),
    row(2100, 2200, '夹在中间的一行'),
    row(3000, 4000, '锁', true),
  ];
  const rep = evenize(rows);
  assert.equal(rep.failures.length, 0);
  assert.equal(rows[1].start, 2100);
  assert.equal(rows[1].end, 2900);
  assert.equal(rows[1].end - rows[1].start, 800);
});

test('evenize: 标签不参与字数权重，空文本按 1 字兜底', () => {
  const rows = [
    row(0, 1000, '锁', true),
    row(2000, 3000, '<i></i>'),
    row(3000, 4000, '{\\an8}'),
    row(9000, 10000, '锁', true),
  ];
  const rep = evenize(rows);
  assert.equal(rep.failures.length, 0);
  // 两者均无可计字数，时长应基本相同（总余量均摊，差不超过 1ms）
  const d1 = rows[1].end - rows[1].start;
  const d2 = rows[2].end - rows[2].start;
  assert.ok(Math.abs(d1 - d2) <= 1, `${d1} vs ${d2}`);
});

test('evenize: 全部锁定时不改动任何行', () => {
  const rows = [
    row(0, 1000, '甲', true),
    row(2000, 3000, '乙', true),
  ];
  const rep = evenize(rows);
  assert.equal(rep.updated, 0);
  assert.equal(rep.updatedRows, 0);
  assert.equal(rep.failures.length, 0);
  assert.deepEqual([rows[0].start, rows[0].end], [0, 1000]);
  assert.deepEqual([rows[1].start, rows[1].end], [2000, 3000]);
});

test('evenize: 倒序或无效时码直接报错', () => {
  assert.throws(() => evenize([row(3000, 2000, '倒序')]), /第 1 行/);
  assert.throws(() => evenize([row(NaN, 2000, '无效')]), /第 1 行/);
});

test('evenize: 边界恰好等于最低需求时可行，末行不越过边界', () => {
  // 2 行最低需求 400 + 100 + 400 = 900；lo=1100、hi=2000，窗口正好 900
  const rows = [
    row(0, 1000, '锁', true),
    row(1200, 1300, '甲'),
    row(1400, 1500, '乙'),
    row(2100, 3000, '锁', true),
  ];
  const rep = evenize(rows);
  assert.equal(rep.failures.length, 0);
  assert.equal(rows[1].start, 1100);
  assert.equal(rows[1].end, 1500);
  assert.equal(rows[2].start, 1600);
  assert.equal(rows[2].end, 2000);
});

test('evenize: 窗口仅差 1ms 时判定容量不足', () => {
  // lo=1101、hi=2000 → 窗口 899，低于最低需求 900
  const rows = [
    row(0, 1001, '锁', true),
    row(1200, 1300, '甲'),
    row(1400, 1500, '乙'),
    row(2100, 3000, '锁', true),
  ];
  const rep = evenize(rows);
  assert.equal(rep.failures.length, 1);
  assert.equal(rep.failures[0].required, 900);
  assert.equal(rep.failures[0].available, 899);
});
