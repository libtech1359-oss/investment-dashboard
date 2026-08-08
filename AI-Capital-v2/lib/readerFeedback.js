'use strict';

/**
 * readerFeedback.js — 読者コメントの手動ログ記録・週次取得
 *
 * note.comのコメントを自動取得する仕組みは存在しないため、管理者がClaude/秘書に
 * 伝えた読者コメントを _add_reader_feedback.js 経由で data/reader_feedback.jsonl に
 * 1行1件のJSONLとして追記する。週刊記事（agents/weekly.js）はgetFeedbackForWeekで
 * 対象週の分だけ読み込み、「読者からこうした視点が寄せられた」という形でLLMの
 * コンテキストに渡す（事実として断定せず、読者由来の視点であることを明示するため）。
 */

const fs   = require('fs');
const path = require('path');

const FEEDBACK_FILE = path.join(__dirname, '..', 'data', 'reader_feedback.jsonl');

function appendFeedback({ date, articleId, comment, theme }) {
  if (!date || !comment) throw new Error('date と comment は必須です');
  const entry = {
    date,
    articleId: articleId || '',
    comment:   String(comment).slice(0, 500),
    theme:     theme || '',
    loggedAt:  new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(FEEDBACK_FILE), { recursive: true });
  fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function readAllFeedback() {
  if (!fs.existsSync(FEEDBACK_FILE)) return [];
  return fs.readFileSync(FEEDBACK_FILE, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(Boolean);
}

function getFeedbackForWeek(startDate, endDate) {
  return readAllFeedback().filter(e => e.date >= startDate && e.date <= endDate);
}

module.exports = { appendFeedback, readAllFeedback, getFeedbackForWeek, FEEDBACK_FILE };
