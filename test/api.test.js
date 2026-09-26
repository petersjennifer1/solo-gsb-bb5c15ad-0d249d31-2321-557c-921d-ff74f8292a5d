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
