'use strict';

/**
 * config/decisionWeights.js — 最終判断ロジックの重み設定
 *
 * AI Capitalの思想: 「部署間の議論」が最終判断の中心であり、
 * Rule Engine（客観指標）とPortfolio評価は、それを補正する役割に留める。
 * signalAggregatorスコア（候補順位）は補助指標であり、単独で結論を左右してはならない。
 * 2026-07-22〜: 「一番スコアが高い銘柄を買う」のではなく「長期ポートフォリオ全体として
 * 最適な判断をする」ため、保有比率・目標資産配分・直近買付履歴も補正要素に加えた。
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

  // ① 保有比率: 対象銘柄の現在の保有比率（0〜100%、時価/総資産）が高いほど連続的に
  // 減点する（集中投資の抑制）。保有比率100%のとき最大でこの値だけ減点する。
  HOLDING_RATIO_MAX_PENALTY: 0.15,

  // ② 目標資産配分: config/targetAllocation.js との乖離を加点・減点する。
  // 目標未達（不足）なら加点、目標超過なら減点。乖離±100pt相当のときの最大振れ幅。
  TARGET_ALLOCATION_MAX_ADJUST: 0.15,

  // ③ 直近買付履歴: 短期間で同じ銘柄を連続購入した場合に減点する（過度な偏りの抑制）。
  RECENT_PURCHASE_COOLDOWN_DAYS: 5,    // この日数以内の同一銘柄購入を減点対象にする
  RECENT_PURCHASE_MAX_PENALTY: 0.15,   // 購入直後（0日後）の最大減点。COOLDOWN_DAYSにかけて線形に0へ減衰
  // その日のRule Engine評価が「今日の理論上限」に対してこの割合以上強い場合は、
  // 直近購入による減点を無効化する（強いシグナルはクールダウンを上回れる）。
  RECENT_PURCHASE_OVERRIDE_RULE_RATIO: 0.8,

  // signalAggregatorスコア（規則エンジン推奨第1候補への極小の後押し）。
  // 単独では部署支持率の差を逆転できない値に留める。
  RANK_ORDER_ASSIST: 0.05,
};
