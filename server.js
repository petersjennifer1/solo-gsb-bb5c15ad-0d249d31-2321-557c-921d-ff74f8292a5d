'use strict';

const path = require('path');
const express = require('express');
const { parseSrt, serializeSrt } = require('./src/srt');
const { alignRevised } = require('./src/align');
const { evenize } = require('./src/evenize');
const { parseCutPoints, avoidCuts, CutParseError } = require('./src/cutpoints');

const app = express();
const PORT = Number(process.env.PORT) || 8080;

app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

/** 上传旧 SRT 文本 + 逐行修订台词，返回全局对齐结果。 */
app.post('/api/align', (req, res) => {
  try {
    const { srt, revised } = req.body || {};
    if (typeof srt !== 'string' || !srt.trim()) {
      return res.status(400).json({ error: '缺少旧版 SRT 内容' });
    }
    if (typeof revised !== 'string' || !revised.trim()) {
      return res.status(400).json({ error: '缺少修订台词内容' });
    }
    const cues = parseSrt(srt);
    if (!cues.length) {
      return res.status(400).json({ error: '未能从 SRT 中解析出任何字幕条目，请检查文件格式' });
    }
    const lines = revised
      .split(/\r?\n/)
      .map((s) => s.replace(/^\s*\d{1,4}\s*[.、):：]\s+/, '').trim())
      .filter((s) => s.length > 0);
    if (!lines.length) {
      return res.status(400).json({ error: '修订台词为空：请保持每行一句台词' });
    }
    res.json(alignRevised(cues, lines));
  } catch (err) {
    console.error('[align]', err);
    res.status(500).json({ error: '对齐失败：' + err.message });
  }
});

/** 接收确认后的行，生成可下载的 SRT。 */
app.post('/api/export', (req, res) => {
  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: '没有可导出的行' });
    }
    const cues = rows.map((r, idx) => {
      const start = Number(r.start);
      const end = Number(r.end);
      const text = String(r.text == null ? '' : r.text).trim();
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
        throw new Error(`第 ${idx + 1} 行时码无效`);
      }
      if (end <= start) {
        throw new Error(`第 ${idx + 1} 行时码倒序，请先修正`);
      }
      if (!text) {
        throw new Error(`第 ${idx + 1} 行文本为空`);
      }
      return { start: Math.round(start), end: Math.round(end), text };
    });
    const overlaps = [];
    for (let k = 1; k < cues.length; k++) {
      if (cues[k].start < cues[k - 1].end) overlaps.push(k + 1);
    }
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="revised.srt"');
    res.setHeader('X-Overlap-Warnings', overlaps.join(',') || 'none');
    res.send('﻿' + serializeSrt(cues));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * 区间匀时：按锁定行切分连续未锁定行，按可见字符数加权重排时码。
 * 入参与 /api/export 一致的 rows（另带 locked），返回更新后的时码与容量不足区间。
 */
app.post('/api/evenize', (req, res) => {
  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: '没有可匀时的行' });
    }
    const work = rows.map((r, idx) => {
      const start = Number(r.start);
      const end = Number(r.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
        throw new Error(`第 ${idx + 1} 行时码无效`);
      }
      return {
        start: Math.round(start),
        end: Math.round(end),
        text: String(r.text == null ? '' : r.text),
        locked: !!r.locked,
      };
    });
    const report = evenize(work);
    res.json({
      rows: work.map((r) => ({ start: r.start, end: r.end, locked: r.locked })),
      updated: report.updated,
      updatedRows: report.updatedRows,
      failures: report.failures,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * 镜头切点避切：cutsText 每行一个 HH:MM:SS,mmm。
 * 对跨越切点的未锁定行，联合选择总时码改动最小的「切点前结束 / 切点后开始」组合；
 * 锁定行不动；无可行方案的行保留原时码并上报行号与原因。
 * 切点格式错误返回 400 并指出输入行号，不改动任何字幕。
 */
app.post('/api/avoid-cuts', (req, res) => {
  try {
    const { rows, cutsText } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: '没有可处理的行' });
    }
    if (typeof cutsText !== 'string' || !cutsText.trim()) {
      return res.status(400).json({ error: '缺少镜头切点：请每行输入一个 HH:MM:SS,mmm' });
    }
    let cuts;
    try {
      cuts = parseCutPoints(cutsText);
    } catch (err) {
      if (err instanceof CutParseError) {
        return res.status(400).json({ error: err.message, line: err.line });
      }
      throw err;
    }
    if (!cuts.length) {
      return res.status(400).json({ error: '未解析出任何切点：请每行输入一个 HH:MM:SS,mmm' });
    }
    const work = rows.map((r, idx) => {
      const start = Number(r.start);
      const end = Number(r.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
        throw new Error(`第 ${idx + 1} 行时码无效`);
      }
      return { start: Math.round(start), end: Math.round(end), locked: !!r.locked };
    });
    const report = avoidCuts(work, cuts);
    res.json({
      cuts,
      rows: work.map((r) => ({ start: r.start, end: r.end, locked: r.locked })),
      adjusted: report.adjusted,
      failures: report.failures,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`字幕校订工具已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
