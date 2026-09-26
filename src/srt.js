'use strict';

/**
 * SRT 解析 / 序列化与时码工具。
 * 时间统一用毫秒（Number）表示。
 */

function toMs(h, m, s, ms) {
  const frac = String(ms).padEnd(3, '0').slice(0, 3);
  return Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + Number(frac);
}

function formatMs(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  const p = (v, n) => String(v).padStart(n, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(f, 3)}`;
}

const TIMECODE_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/**
 * 解析 SRT 文本，返回 [{ index, start, end, text }]。
 * 容错：BOM、\r\n、缺失序号、时码行后的位置参数。
 */
function parseSrt(content) {
  const text = String(content).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n[ \t]*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
    if (!lines.length) continue;
    let cursor = 0;
    let index = null;
    if (/^\d{1,6}$/.test(lines[0].trim())) {
      index = parseInt(lines[0].trim(), 10);
      cursor = 1;
    }
    const timeLine = lines[cursor];
    if (!timeLine) continue;
    const m = timeLine.match(TIMECODE_RE);
    if (!m) continue;
    cues.push({
      index: index == null ? cues.length + 1 : index,
      start: toMs(m[1], m[2], m[3], m[4]),
      end: toMs(m[5], m[6], m[7], m[8]),
      text: lines.slice(cursor + 1).join('\n'),
    });
  }
  return cues;
}

/** 序列化为 SRT 文本，序号按数组顺序重排。 */
function serializeSrt(cues) {
  return (
    cues
      .map((c, i) => `${i + 1}\n${formatMs(c.start)} --> ${formatMs(c.end)}\n${c.text}`)
      .join('\n\n') + '\n'
  );
}

module.exports = { parseSrt, serializeSrt, formatMs, toMs };
