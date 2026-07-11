'use strict';

/**
 * Fear & Greed Index を 5段階ラベルに変換する
 * 76-100: 極端な強欲 / 55-75: 強欲 / 46-54: 中立 / 26-45: 恐怖 / 0-25: 極端な恐怖
 */
function fgLabel(score) {
  const n = parseInt(score ?? 50);
  if (n >= 76) return '極端な強欲';
  if (n >= 55) return '強欲';
  if (n >= 46) return '中立';
  if (n >= 26) return '恐怖';
  return '極端な恐怖';
}

/**
 * 表示用: "25（極端な恐怖）" のような文字列を返す
 */
function fgDisplay(score) {
  return `${score}（${fgLabel(score)}）`;
}

module.exports = { fgLabel, fgDisplay };
