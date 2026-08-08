'use strict';
require('dotenv').config();

/**
 * 読者コメントを data/reader_feedback.jsonl に1件記録する。
 * 週刊記事の「AIの成長記録」生成時に、その週の分がLLMコンテキストへ渡される。
 *
 * 使い方:
 *   node _add_reader_feedback.js <date:YYYY-MM-DD> <articleId> "<コメント本文>" "<論点タグ>"
 *
 * 例:
 *   node _add_reader_feedback.js 2026-08-07 AC-2026-0014 "ルール高評価でも部署で意見が割れるのは、数字以上に時間軸の判断が重いからか。Fear & Greed60強欲な相場で、Zテック20への傾斜ぶりが知りたい。" "時間軸/RuleEngine乖離"
 */

const { appendFeedback } = require('./lib/readerFeedback');

const [date, articleId, comment, theme] = process.argv.slice(2);

if (!date || !comment) {
  console.error('使い方: node _add_reader_feedback.js <date:YYYY-MM-DD> <articleId> "<コメント本文>" "<論点タグ>"');
  process.exit(1);
}

const entry = appendFeedback({ date, articleId, comment, theme });
console.log('[reader_feedback] 記録しました:');
console.log(JSON.stringify(entry, null, 2));
