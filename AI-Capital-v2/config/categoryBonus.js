'use strict';

/**
 * config/categoryBonus.js — 候補資産「資産カテゴリ」補正
 *
 * 目的:
 *   AI Capitalは長期積立・資産形成を目的としているが、candidate_assets の総合評価スコアは
 *   値動きの大きい銘柄（SOX・日経平均等）ほど高スコアが出やすく、Core資産（オルカン・S&P500）が
 *   選ばれにくい構造になっている。僅差の場合に限りCore資産を後押しする小さな補正を加える。
 *
 *   日経平均は asset_master 上は category='core' だが、本補正の対象からは意図的に除外する
 *   （「SOX・日経平均への偏り」を是正するのが目的のため、日経平均自体にボーナスを与えると
 *   目的と矛盾する。管理者確認済み・2026-07-29）。
 *   対象は下記 CORE_ASSETS の2銘柄のみとし、asset_master の category フィールドは参照しない。
 *
 * 優先順位（config/decisionWeights.js の設計思想を継承・config/candidatePenalty.js ヘッダー参照）:
 *   1. 市場データ・Rule Engine（candidate_assetsの総合評価） … lib/signalAggregator.js の ruleAdjust
 *   2. ポートフォリオ状況（保有比率・目標配分・直近購入） … holdingRatioAdjust / allocationAdjust / cooldownAdjust
 *   3. 資産カテゴリ補正（本ファイル） … categoryAdjust
 *   4. 採用履歴補正（config/candidatePenalty.js） … balanceAdjust ← 最も弱い補正
 *   市場データやRule Engineを覆すほど強くしてはならない（CORE_BONUS は decisionWeights.js の
 *   各補正値・candidatePenalty.js の MAX_PENALTY より小さく保つこと）。
 *
 * 数値の調整はこのファイルでのみ行い、lib/signalAggregator.js にはハードコードしない。
 */

module.exports = {
  // Core資産（僅差の場合のみ選ばれやすくなるよう後押しする対象）。
  CORE_ASSETS: ['オルカン', 'S&P500'],

  // CORE_ASSETSに該当する候補への加点。decisionWeights.jsの各補正値・candidatePenalty.jsの
  // MAX_PENALTY(0.05)より小さく保ち、僅差のケースのみを左右する弱い補正に留める。
  CORE_BONUS: 0.03,
};
