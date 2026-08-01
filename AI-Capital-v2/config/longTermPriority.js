'use strict';

/**
 * config/longTermPriority.js — 観測ポジションモードの長期保有優先度リスト
 *
 * Observation Candidate Filter（lib/signalAggregator.js の applyObservationCandidateFilter）が、
 * Rule Engine上位候補のスコア差が僅差（config/decisionWeights.js の
 * OBSERVATION_FILTER_MAX_SCORE_GAP 以内）の場合にのみ参照する。
 * 配列のインデックスが小さいほど優先度が高い（長期保有に適した資産を優先）。
 * リストに含まれない銘柄は最下位（優先度なし）として扱う。
 */

module.exports = [
  'オルカン',
  'S&P500',
  'NASDAQ100',
  'FANG+',
  'SOX',
  'Zテック20',
  '日経平均',
  'ゴールド',
];
