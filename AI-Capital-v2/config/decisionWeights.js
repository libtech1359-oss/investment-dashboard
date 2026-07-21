'use strict';

/**
 * config/decisionWeights.js — 最終判断ロジックの重み設定
 *
 * AI Capitalの思想: 「部署間の議論」が最終判断の中心であり、
 * Rule Engine（客観指標）とPortfolio評価は、それを補正する役割に留める。
 * signalAggregatorスコア（候補順位）は補助指標であり、単独で結論を左右してはならない。
 *
 * 数値の調整はこのファイルでのみ行い、lib/signalAggregator.js にはハードコードしない。
 */

module.exports = {
  // 部署支持率×信頼度（voteScore, 0〜1）＝最終判断の基礎スコア。ここが決定打。
  DEPT_BASE_WEIGHT: 1.0,

  // Rule Engine（ATH乖離率ランク・Fear&Greed・VIX）による補正の最大振れ幅（±）。
  // voteScore（0〜1の全域）に対してこの範囲でしか動かせないため、部署支持率の
  // 大差は覆せず、僅差・ほぼ同点のケースのみを左右する設計。
  RULE_ENGINE_MAX_ADJUST: 0.20,

  // Fear & Greedが恐怖圏に近いほどRule Engineの補正を強める強度係数。
  // extreme: FG<=25 / fear: FG<=45 / neutral: それ以上
  RULE_ENGINE_FG_INTENSITY: { extreme: 1.0, fear: 0.6, neutral: 0.3 },

  // VIXが高い（不確実性が高い）ほどRule Engineの補正を弱め、部署判断を優先する減衰係数。
  // high: VIX>=30 / elevated: VIX>=20 / normal: それ未満
  RULE_ENGINE_VIX_DAMP: { high: 0.5, elevated: 0.8, normal: 1.0 },

  // Portfolio評価（集中投資率）による補正の最大振れ幅（±）。リスク管理目的。
  PORTFOLIO_MAX_ADJUST: 0.20,
  CONCENTRATION_THRESHOLD_PCT: 25, // この集中投資率（%）を超えたら減点

  // signalAggregatorスコア（規則エンジン推奨第1候補への極小の後押し）。
  // 単独では部署支持率の差を逆転できない値に留める。
  RANK_ORDER_ASSIST: 0.05,
};
