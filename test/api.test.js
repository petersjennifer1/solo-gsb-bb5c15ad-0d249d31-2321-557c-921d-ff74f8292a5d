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

test('POST /api/avoidcuts: 跨切点未锁定行从切点后开始，锁定行不动', async () => {
  const { status, json } = await callApi('/api/avoidcuts', {
    rows: [
      { start: 0, end: 1000, text: '不跨', locked: true },
      { start: 2000, end: 6000, text: '跨切点的一行' },
    ],
    cuts: [3000],
  });
  assert.equal(status, 200);
  assert.equal(json.rows[0].start, 0);
  assert.equal(json.rows[0].end, 1000);
  // 切前缩短改动 3000，切后缩短改动 1000 → 从切点后开始
  assert.deepEqual([json.rows[1].start, json.rows[1].end], [3000, 6000]);
});

test('POST /api/avoidcuts: 切点前结束为更省方案时采用', async () => {
  const { status, json } = await callApi('/api/avoidcuts', {
    rows: [{ start: 2000, end: 6000, text: '跨切点的一行' }],
    cuts: [5000],
  });
  assert.equal(status, 200);
  // 切前缩短改动 1000，切后缩短改动 3000 → 在切点前结束
  assert.deepEqual([json.rows[0].start, json.rows[0].end], [2000, 5000]);
  assert.equal(json.failures.length, 0);
  assert.equal(json.spanning.length, 0);
});

test('POST /api/avoidcuts: 无可行方案行保留原时码并给行号原因', async () => {
  const { status, json } = await callApi('/api/avoidcuts', {
    rows: [
      { start: 100, end: 1100, text: '两侧被挤' },
      { start: 700, end: 3000, text: '右邻锁定', locked: true },
    ],
    cuts: [400],
  });
  assert.equal(status, 200);
  assert.equal(json.updated, 0);
  assert.equal(json.failures.length, 1);
  assert.equal(json.failures[0].line, 1);
  assert.match(json.failures[0].reason, /无可行方案/);
  assert.deepEqual([json.rows[0].start, json.rows[0].end], [100, 1100]);
  assert.deepEqual(json.spanning, [1]);
});

test('POST /api/avoidcuts: 锁定行跨切点时上报且时码不变', async () => {
  const { status, json } = await callApi('/api/avoidcuts', {
    rows: [{ start: 1000, end: 3000, text: '锁定', locked: true }],
    cuts: [2000],
  });
  assert.equal(status, 200);
  assert.equal(json.updated, 0);
  assert.equal(json.failures[0].line, 1);
  assert.match(json.failures[0].reason, /锁定/);
  assert.deepEqual([json.rows[0].start, json.rows[0].end], [1000, 3000]);
});

test('POST /api/avoidcuts: 参数校验', async () => {
  const noRows = await callApi('/api/avoidcuts', { rows: [], cuts: [1000] });
  assert.equal(noRows.status, 400);
  const noCuts = await callApi('/api/avoidcuts', { rows: [{ start: 0, end: 1000, text: '甲' }], cuts: [] });
  assert.equal(noCuts.status, 400);
  const bad = await callApi('/api/avoidcuts', {
    rows: [{ start: 3000, end: 2000, text: '倒序' }],
    cuts: [2500],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /第 1 行/);
});
