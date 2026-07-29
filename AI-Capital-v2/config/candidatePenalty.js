'use strict';

/**
 * config/candidatePenalty.js — 候補資産「採用履歴」バランス補正
 *
 * 目的:
 *   candidate_assets の評価が「その日のスコア」だけに依存すると、SOXや日経平均のような
 *   高スコアが出やすい銘柄へ判断が偏りやすい。直近 LOOKBACK_DECISIONS 件の final_decisions
 *   を確認し、同一銘柄が繰り返し採用されている場合にのみ軽い減点を与えることで、
 *   僅差の候補にも選定機会を残す（禁止ではなく、あくまで補正）。
 *
 * 優先順位（config/decisionWeights.js の設計思想を継承）:
 *   1. 市場データ（ATH乖離率・Fear&Greed・前日比など） … lib/signalAggregator.js の ruleAdjust
 *   2. Rule Engine（candidate_assetsの総合評価） … ruleAdjust
 *   3. ポートフォリオ状況（保有比率・目標配分・直近購入） … holdingRatioAdjust / allocationAdjust / cooldownAdjust
 *   4. 資産カテゴリ補正（config/categoryBonus.js） … categoryAdjust
 *   5. 採用履歴補正（本ファイル） … balanceAdjust ← 最も弱い補正
 *   優位性が十分にある候補は、採用履歴補正だけでは逆転しない値に留めること
 *   （MAX_PENALTY は decisionWeights.js の各補正値より小さく保つ）。
 *
 * 数値の調整はこのファイルでのみ行い、lib/signalAggregator.js にはハードコードしない。
 */

module.exports = {
  // 採用履歴を確認する直近の判断件数（営業日ベース。BUY/ACCUMULATEでtarget_assetが
  // 決定した final_decisions のみをカウント対象とする。WAIT/DEFEND/SELLは対象外）。
  LOOKBACK_DECISIONS: 5,

  // この回数未満の採用では補正しない（1回程度の採用は自然な選択として許容し、
  // 「毎回1点減点され続ける」ような過敏な補正を避ける）。
  MIN_OCCURRENCES: 2,

  // LOOKBACK_DECISIONS件すべてで同一銘柄が採用された場合の最大減点幅。
  // 採用回数に比例して線形に増加する（例: 直近5件中4回採用 → MAX_PENALTY × 4/5）。
  // decisionWeights.js の RULE_ENGINE_MAX_ADJUST(0.20)・HOLDING_RATIO_MAX_PENALTY(0.15)・
  // TARGET_ALLOCATION_MAX_ADJUST(0.15) より小さく抑え、僅差のケースのみを左右する。
  MAX_PENALTY: 0.05,

  // ── 将来の実績学習用（今回は未実装・設計のみ） ──────────────────────
  // department_recommendations / final_decisions は将来の学習データとして蓄積を続ける。
  // 十分な履歴が貯まった後、以下の実績指標を balanceAdjust に合成できるよう
  // キーだけ予約しておく（現時点ではどのコードからも参照しない）。
  //   PERFORMANCE_WEIGHT: 0        … 採用勝率・平均リターンをbalanceAdjustへ反映する重み
  //   MAX_DRAWDOWN_WEIGHT: 0       … 採用後の最大DDをbalanceAdjustへ反映する重み
  //   DEPT_WIN_RATE_WEIGHT: 0      … 部署別勝率をvoteScoreへ反映する重み
  // 有効化する際は、この3キーを0以外にし、算出ロジックをsignalAggregator.jsではなく
  // 新設の lib/performanceTracker.js 等に切り出すこと（本ファイルには重みのみを置く）。
};
