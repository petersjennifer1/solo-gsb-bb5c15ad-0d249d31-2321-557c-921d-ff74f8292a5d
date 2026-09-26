'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSrt, serializeSrt, formatMs } = require('../src/srt');
const { alignRevised, normalizeText, similarity, splitRange, flagRows } = require('../src/align');

const cue = (index, start, end, text) => ({ index, start, end, text });

test('parseSrt: 基本解析（含 BOM、CRLF、多行文本）', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:03,500\r\n第一行\r\n第二行\r\n\r\n2\n00:00:04.000 --> 00:00:06.000\n下一条\n';
  const cues = parseSrt(srt);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { index: 1, start: 1000, end: 3500, text: '第一行\n第二行' });
  assert.equal(cues[1].start, 4000);
  assert.equal(cues[1].end, 6000);
});

test('serializeSrt: 与解析互逆', () => {
  const cues = [
    { start: 1000, end: 2500, text: '你好' },
    { start: 61000, end: 63500, text: '世界\n第二行' },
  ];
  const out = serializeSrt(cues);
  assert.match(out, /1\n00:00:01,000 --> 00:00:02,500\n你好/);
  assert.match(out, /2\n00:01:01,000 --> 00:01:03,500\n世界\n第二行/);
  const back = parseSrt(out);
  assert.equal(back.length, 2);
  assert.equal(back[1].text, '世界\n第二行');
});

test('formatMs: 进位与补零', () => {
  assert.equal(formatMs(0), '00:00:00,000');
  assert.equal(formatMs(3723456), '01:02:03,456');
});

test('normalizeText: 去标点、全角转半角、剥标签', () => {
  assert.equal(normalizeText('<i>你好，世界！</i>'), '你好世界');
  assert.equal(normalizeText('ＡＢＣ 123…'), 'abc123');
  assert.equal(normalizeText('{\\an8}他说： “走吧。”'), '他说走吧');
});

test('similarity: 相同为 1，无关趋近 0', () => {
  assert.equal(similarity('你好世界', '你好世界'), 1);
  assert.ok(similarity('你好世界', '你好呀世界') > 0.5);
  assert.ok(similarity('你好世界', ' completely different ') < 0.3);
});

test('alignRevised: 1:1 配对沿用原时段', () => {
  const old = [
    cue(1, 1000, 2000, '我们今天去爬山'),
    cue(2, 3000, 4500, '天气非常好'),
  ];
  const { rows, stats } = alignRevised(old, ['我们今天去爬山了', '天气非常好']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].start, 1000);
  assert.equal(rows[0].end, 2000);
  assert.equal(rows[1].start, 3000);
  assert.equal(stats.pending, 0);
  assert.deepEqual(rows[0].flags, []);
});

test('alignRevised: 一拆二，按修订文字长度分配原时段', () => {
  const old = [cue(1, 10000, 16000, '前面一句话后面还有一句话')];
  const { rows, stats } = alignRevised(old, ['前面一句话', '后面还有一句话']);
  assert.equal(rows.length, 2);
  assert.equal(stats.splits, 1);
  assert.equal(rows[0].start, 10000);
  assert.equal(rows[1].end, 16000);
  assert.equal(rows[0].end, rows[1].start);
  // 5 字 vs 7 字 → 切点应约在 10000 + 6000*5/12 = 12500
  assert.ok(Math.abs(rows[0].end - 12500) <= 500, `cut=${rows[0].end}`);
  assert.ok(rows[0].end - rows[0].start >= 400);
  assert.ok(rows[1].end - rows[1].start >= 400);
});

test('alignRevised: 二并一，沿用覆盖时段', () => {
  const old = [
    cue(1, 2000, 3500, '他说了一个很长的句子'),
    cue(2, 3600, 5000, '被切成了两条字幕'),
    cue(3, 6000, 7000, '后面正常'),
  ];
  const { rows, stats } = alignRevised(old, ['他说了一个很长的句子被切成了两条字幕', '后面正常']);
  assert.equal(rows.length, 2);
  assert.equal(stats.merges, 1);
  assert.equal(rows[0].start, 2000);
  assert.equal(rows[0].end, 5000);
  assert.deepEqual(rows[0].oldRefs.map((o) => o.index), [1, 2]);
});

test('alignRevised: 重复台词按前后文归位', () => {
  const old = [
    cue(1, 1000, 2000, '谢谢'),
    cue(2, 3000, 4000, '不客气'),
    cue(3, 5000, 6000, '大家安静一下'),
    cue(4, 7000, 8000, '谢谢'),
    cue(5, 9000, 10000, '演出开始了'),
  ];
  // 修订稿保留两句"谢谢"，第二句略有改动
  const { rows } = alignRevised(old, ['谢谢', '不客气', '大家安静一下', '谢谢你们', '演出开始了']);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0].oldRefs.map((o) => o.index), [1]);
  assert.deepEqual(rows[3].oldRefs.map((o) => o.index), [4]);
  assert.equal(rows[3].start, 7000);
  assert.equal(rows[3].end, 8000);
});

test('alignRevised: 修订稿新增行标记 unmatched 并插值时段', () => {
  const old = [
    cue(1, 1000, 2000, '第一句台词'),
    cue(2, 8000, 9000, '最后一句台词'),
  ];
  const { rows } = alignRevised(old, ['第一句台词', '这是全新插入的一句旁白', '最后一句台词']);
  assert.equal(rows.length, 3);
  assert.ok(rows[1].flags.includes('unmatched'));
  assert.equal(rows[1].start, 2000); // 接上一行结束
  assert.equal(rows[1].end, 8000);   // 到下一行开始
  assert.equal(rows[2].start, 8000);
});

test('alignRevised: 旧条目被删除时进入 droppedOld', () => {
  const old = [
    cue(1, 1000, 2000, '保留下来的句子'),
    cue(2, 3000, 4000, '这句在修订稿里被整句删掉了'),
    cue(3, 5000, 6000, '也保留下来'),
  ];
  const { rows, droppedOld, stats } = alignRevised(old, ['保留下来的句子', '也保留下来']);
  assert.equal(rows.length, 2);
  assert.equal(droppedOld.length, 1);
  assert.equal(droppedOld[0].index, 2);
  assert.equal(stats.dropped, 1);
});

test('alignRevised: 大改动的行标记 uncertain', () => {
  const old = [
    cue(1, 1000, 2000, '原来的台词完全被重写了'),
    cue(2, 3000, 4000, '这句保持不变'),
  ];
  const { rows } = alignRevised(old, ['entirely replaced english line', '这句保持不变']);
  assert.ok(rows[0].flags.includes('uncertain'));
  assert.ok(!rows[1].flags.includes('uncertain'));
});

test('flagRows: 检测倒序与重叠', () => {
  const rows = flagRows([
    { start: 1000, end: 2000, sim: 1, flags: [] },
    { start: 1500, end: 2500, sim: 1, flags: [] }, // 与上一行重叠
    { start: 3000, end: 2900, sim: 1, flags: [] }, // 倒序
  ]);
  assert.ok(rows[1].flags.includes('overlap'));
  assert.ok(rows[2].flags.includes('reversed'));
  assert.ok(!rows[0].flags.length);
});

test('splitRange: 极短时段不产生倒序', () => {
  const [[s1, e1], [s2, e2]] = splitRange(1000, 1300, 'aaaa', 'b');
  assert.ok(e1 >= s1);
  assert.ok(e2 >= s2);
  assert.equal(e1, s2);
});

test('alignRevised: 规模冒烟测试（800 条）', () => {
  const old = [];
  const rev = [];
  for (let k = 0; k < 800; k++) {
    old.push(cue(k + 1, k * 3000, k * 3000 + 2500, `第${k}句台词内容差不多这样`));
    rev.push(`第${k}句台词内容差不多这样了`);
  }
  const t0 = Date.now();
  const { rows, stats } = alignRevised(old, rev);
  const elapsed = Date.now() - t0;
  assert.equal(rows.length, 800);
  assert.ok(stats.pending <= 800 * 0.05, `pending=${stats.pending}`);
  assert.ok(elapsed < 15000, `elapsed=${elapsed}ms`);
});
