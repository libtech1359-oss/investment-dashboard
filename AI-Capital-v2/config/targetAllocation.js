'use strict';

/**
 * config/targetAllocation.js — 銘柄ごとの目標資産配分（%）
 *
 * signalAggregator.js の銘柄選定で「目標配分に対して不足しているか・超過しているか」を
 * 評価するために使用する（不足なら加点、超過なら減点）。
 * 対象は投資中資金（invested）に占める比率であり、現金比率は含まない。
 * 合計が100%になる必要はない（未設定分はどの銘柄にも属さない余白として扱われる）。
 *
 * 値は初期デフォルト（asset_master のカテゴリ別の目安配分: core > growth > defense > theme）
 * であり、実際の運用方針に合わせて管理者が調整すること。銘柄名は candidate_assets /
 * asset_master の short_name（例: "SOX"）と一致させる。
 */

module.exports = {
  // core（コア指数）
  'オルカン':   15,
  'S&P500':    15,
  'NASDAQ100': 15,
  '日経平均':   15,
  // growth（成長セクター）
  'FANG+':     10,
  'SOX':       10,
  // defense（守備）
  'ゴールド':   10,
  // theme（サテライト）
  '宇宙開発':    5,
  'Zテック20':   5,
};
