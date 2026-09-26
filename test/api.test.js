'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');

function callApi(path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const port = server.address().port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        resolve({ status: res.status, json });
      } finally {
        server.close();
      }
    });
  });
}

test('GET /api/health', async () => {
  await new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      server.close(resolve);
    });
  });
});

test('POST /api/evenize: 锁定行之间按可见字数重排', async () => {
  const { status, json } = await callApi('/api/evenize', {
    rows: [
      { start: 0, end: 1000, text: '锁', locked: true },
      { start: 2000, end: 3000, text: '短' },
      { start: 4000, end: 5000, text: '这是一句明显更长的台词有十几个字' },
      { start: 9000, end: 10000, text: '锁', locked: true },
    ],
  });
  assert.equal(status, 200);
  assert.equal(json.failures.length, 0);
  assert.equal(json.rows[0].start, 0);
  assert.equal(json.rows[0].end, 1000);
  assert.ok(json.rows[0].locked);
  assert.equal(json.rows[3].start, 9000);
  assert.ok(json.rows[1].start >= 1100);
  assert.ok(json.rows[2].end <= 8900);
  assert.ok(json.rows[2].end - json.rows[2].start > json.rows[1].end - json.rows[1].start);
});

test('POST /api/evenize: 容量不足区间原样返回并报告', async () => {
  const rows = [
    { start: 0, end: 500, text: '锁', locked: true },
    { start: 1000, end: 1100, text: '甲' },
    { start: 1100, end: 1200, text: '乙' },
    { start: 1300, end: 1600, text: '锁', locked: true },
  ];
  const { status, json } = await callApi('/api/evenize', { rows });
  assert.equal(status, 200);
  assert.equal(json.failures.length, 1);
  assert.deepEqual([json.failures[0].from, json.failures[0].to], [2, 3]);
  assert.equal(json.failures[0].required, 900); // 2*400 + 100
  assert.equal(json.failures[0].available, 600); // (1300-100) - (500+100)
  assert.equal(json.rows[1].start, 1000);
  assert.equal(json.rows[2].end, 1200);
});

test('POST /api/evenize: 参数校验', async () => {
  const empty = await callApi('/api/evenize', { rows: [] });
  assert.equal(empty.status, 400);
  const bad = await callApi('/api/evenize', {
    rows: [{ start: 3000, end: 2000, text: '倒序' }],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /第 1 行/);
});

test('POST /api/avoid-cuts: 跨越切点的未锁定行被避让，锁定行不动', async () => {
  const { status, json } = await callApi('/api/avoid-cuts', {
    cutsText: '00:00:01,500\n00:00:02,500',
    rows: [
      { start: 0, end: 1000, locked: true },
      { start: 1050, end: 2000 }, // 跨 1500，受锁定行牵制只能切点后开始
      { start: 2100, end: 3000 }, // 跨 2500，B（start=2500，代价 400）优于 A（代价 500）
    ],
  });
  assert.equal(status, 200);
  assert.deepEqual(json.cuts, [1500, 2500]);
  assert.deepEqual([json.rows[0].start, json.rows[0].end], [0, 1000]);
  assert.deepEqual([json.rows[1].start, json.rows[1].end], [1500, 2000]);
  assert.deepEqual([json.rows[2].start, json.rows[2].end], [2500, 3000]);
  assert.deepEqual(json.adjusted, [2, 3]);
  assert.deepEqual(json.failures, []);
});

test('POST /api/avoid-cuts: 无可行方案的行保留原时码并报告行号与原因', async () => {
  const { status, json } = await callApi('/api/avoid-cuts', {
    cutsText: '00:00:01,200',
    rows: [
      { start: 0, end: 1000, locked: true },
      { start: 1050, end: 1300 },
      { start: 1650, end: 2000, locked: true },
    ],
  });
  assert.equal(status, 200);
  assert.deepEqual(json.adjusted, []);
  assert.equal(json.failures.length, 1);
  assert.deepEqual(json.failures[0].rows, [2]);
  assert.match(json.failures[0].reason, /第 2 行|锁定行/);
  assert.deepEqual([json.rows[1].start, json.rows[1].end], [1050, 1300]); // 原时码不动
});

test('POST /api/avoid-cuts: 切点格式错误指出输入行号且不改动字幕', async () => {
  const { status, json } = await callApi('/api/avoid-cuts', {
    cutsText: '00:00:02,500\n不是时码',
    rows: [{ start: 1000, end: 3000 }],
  });
  assert.equal(status, 400);
  assert.equal(json.line, 2);
  assert.match(json.error, /第 2 行/);
  assert.ok(!json.rows); // 不返回任何改动
});

test('POST /api/avoid-cuts: 参数校验', async () => {
  const noRows = await callApi('/api/avoid-cuts', { rows: [], cutsText: '00:00:01,000' });
  assert.equal(noRows.status, 400);
  const noCuts = await callApi('/api/avoid-cuts', { rows: [{ start: 0, end: 1000 }], cutsText: '  ' });
  assert.equal(noCuts.status, 400);
  const reversed = await callApi('/api/avoid-cuts', {
    rows: [{ start: 3000, end: 2000 }],
    cutsText: '00:00:02,500',
  });
  assert.equal(reversed.status, 400);
  assert.match(reversed.json.error, /第 1 行/);
});
