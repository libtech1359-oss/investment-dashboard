'use strict';

/**
 * candidateGroups.js — 記事の「本日の買付候補」表示（🥇Core / 🚀Growth / 🛡Defense）と
 * 各部署（神谷シン・橘アオイ・黒崎ミサキ・鬼塚ガイ）の議論対象を一致させるための
 * 唯一の情報源（Single Source of Truth）。
 *
 * config/categoryBonus.js のCoreボーナス対象とは別軸の「表示用グルーピング」。
 * 日経平均はCoreボーナス対象外だが、表示上はCore候補枠に含める（管理者確認済み）。
 * 宇宙開発はTheme枠が未整備のため候補表示・部署議論の対象外（Rule Engineの採点・
 * 最終判断ロジックには引き続き参加する）。
 */

const CANDIDATE_DISPLAY_GROUPS = {
  core:    { label: '🥇 Core候補',    names: ['オルカン', 'S&P500', '日経平均'] },
  growth:  { label: '🚀 Growth候補',  names: ['NASDAQ100', 'FANG+', 'SOX', 'Zテック20'] },
  defense: { label: '🛡 Defense候補', names: ['ゴールド'] },
};

function topOfGroup(candidates, names) {
  const inGroup = candidates.filter(c => names.includes(c.asset_name));
  if (inGroup.length === 0) return null;
  return [...inGroup].sort((a, b) => parseInt(a.rank || 99) - parseInt(b.rank || 99))[0];
}

// candidate_assets の全候補から、記事に表示されるCore/Growth/Defense代表3銘柄だけを抽出する。
// 各部署のLLMコンテキスト・記事の候補表示は、必ずこの関数の戻り値を参照すること。
function getDisplayCandidates(candidates) {
  return Object.entries(CANDIDATE_DISPLAY_GROUPS)
    .map(([category, { label, names }]) => {
      const top = topOfGroup(candidates, names);
      return top ? { category, label, ...top } : null;
    })
    .filter(Boolean);
}

// 短名・フルネームどちらで返ってきても一致とみなす双方向部分一致
// （lib/signalAggregator.js の matchesOne と同じ考え方）。
// 例：「ゴールド（SBI・iシェアーズ・ゴールドファンド）」→ 短名「ゴールド」に一致
function namesMatch(a, b) {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// 部署LLMが返した asset_name が表示候補3件（またはWAIT時の「なし」）の範囲内かを判定する。
// 範囲外の場合、呼び出し側で安全側WAITに丸めること。
function isAllowedAssetName(displayCandidates, assetName) {
  if (!assetName || assetName === 'なし' || assetName === '') return true;
  return displayCandidates.some(c => namesMatch(assetName, c.asset_name) || namesMatch(assetName, c.full_name));
}

module.exports = {
  CANDIDATE_DISPLAY_GROUPS,
  topOfGroup,
  getDisplayCandidates,
  isAllowedAssetName,
};
