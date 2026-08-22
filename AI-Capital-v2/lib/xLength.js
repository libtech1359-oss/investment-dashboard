'use strict';

/**
 * X（旧Twitter）の実際の文字数制限を扱うユーティリティ。
 * Xは絵文字・記号を除くと280の「加重長」制限で、日本語（CJK）は1文字=weight2で
 * カウントされるため、日本語中心の投稿は実質140字程度までしか通らない。
 * ローカル小型LLM（gemma4:e4b）に文字数指示を守らせるのは信頼できないため
 * （[[feedback-ollama-gemma4-behavior]]）、生成後に機械的に強制する。
 */

const twttr = require('twitter-text');

// publisher.jsのX_SYSTEMが必ず出力する固定フッターの開始位置を示すマーカー。
// プロンプト側の文言を変更したらここも合わせて変更すること。
const SUFFIX_MARKER = '続きはnoteで';

function checkXLength(text) {
  const r = twttr.parseTweet(text);
  return { valid: r.valid, weightedLength: r.weightedLength };
}

/**
 * 制限超過時、固定フッター（URL・ハッシュタグを含む）は必ず残したまま、
 * それより前の自由記述部分だけを末尾から削って制限内に収める。
 */
function enforceXLength(text) {
  if (checkXLength(text).valid) return text;

  const idx = text.indexOf(SUFFIX_MARKER);
  if (idx === -1) {
    console.warn('[xLength] フッターマーカーが見つからず機械トリムできません（生成結果をそのまま返します）');
    return text;
  }
  const suffix = text.slice(idx);
  const prefixChars = Array.from(text.slice(0, idx).trimEnd());

  while (prefixChars.length > 0) {
    const candidate = `${prefixChars.join('')}\n\n${suffix}`;
    if (checkXLength(candidate).valid) {
      console.warn(`[xLength] X投稿文が制限超過のため機械トリムしました（${text.length}字→${candidate.length}字）`);
      return candidate;
    }
    prefixChars.pop();
  }
  console.warn('[xLength] 機械トリムしてもフッターだけで制限超過。フッターのみ返します');
  return suffix;
}

module.exports = { checkXLength, enforceXLength };
