'use strict';

/**
 * config/candidateScoreWeights.js — candidate_assets 総合評価スコアの重み設定
 *
 * AI Capitalの思想: 「下落したから買う」逆張り一本足打法を廃止し、
 * 価格モメンタム（ATH乖離・前日比）とポートフォリオ構成（保有比率・目標配分乖離・
 * カテゴリー分散）を総合した「総合評価スコア」で候補銘柄をランク付けする。
 * どの1指標も単独でスコアを支配しないよう、各成分を -1〜+1 に正規化してから重みを掛ける。
 *
 * Fear & Greed / VIX は日次で全銘柄共通の値（銘柄間の相対順位を左右しない）のため、
 * このスコアには含めない。市場心理・不確実性の判断材料としては各部署のプロンプト
 * コンテキスト（market_data）で引き続き提供され、部署の投票・コメントで評価される。
 *
 * 数値の調整はこのファイルでのみ行い、lib/dataFetcher.js にはハードコードしない。
 * 新しい評価項目（保有日数・連続購入抑制・部署別勝率など）を追加する場合は、
 * lib/dataFetcher.js の scoreCandidate() に成分を追加し、ここに重みを追加する。
 */

module.exports = {
  // 価格モメンタム系（値が大きいほど「割安・下落している」を意味する。単独で結論を出さない）
  ATH_GAP_WEIGHT:       0.25, // ATH乖離率（clamp ±30%を±1に正規化）
  DAILY_CHANGE_WEIGHT:  0.15, // 前日比（clamp ±5%を±1に正規化）

  // ポートフォリオ構成系（方向性を持たない。分散・配分バランスの是正が目的）
  HOLDING_RATIO_WEIGHT:      0.20, // 保有比率（総資産比）が高いほど減点
  ALLOCATION_GAP_WEIGHT:     0.25, // 目標配分（config/targetAllocation.js）との乖離。不足なら加点・超過なら減点
  CATEGORY_DIVERSITY_WEIGHT: 0.15, // 同カテゴリーの保有比率が高いほど減点（分散推奨）
};
