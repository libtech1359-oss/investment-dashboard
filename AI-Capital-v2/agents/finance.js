'use strict';

/**
 * finance.js — 財務戦略部（非公開・隠し部署）
 *
 * 「AI Capital 組織改編」で正式公開するまで secretary.js のパイプラインからは
 * 一切呼び出されない。config/financeStrategy.isEnabled() が true になった後に
 * secretary.js へ呼び出しを1行追加するだけで参加できるよう、既存部署
 * （market/portfolio/risk）と同じ analyze(date) インターフェースで実装しておく。
 *
 * 役割: 利益確定提案 / リバランス提案 / 現金比率管理 / 集中投資率管理 / 次回暴落への資金確保
 * シグナル: HOLD | REDUCE | SELL | REBALANCE
 */

const financeStrategy = require('../config/financeStrategy');

const DEPT       = '財務戦略部';
const AGENT_NAME = '財前ミナ';

/**
 * @param {string} date - YYYY-MM-DD
 * @param {object|null} portfolioStatus - portfolio_status行相当（cash等）。省略時は無効判定。
 * @returns {Promise<object|null>} 未解放時はnull。呼び出し元はnullを無視すること。
 */
async function analyze(date, portfolioStatus = null) {
  const cash = Number(portfolioStatus?.cash || 0);
  if (!financeStrategy.isEnabled(cash)) {
    return null;
  }

  // TODO(組織改編時): 利益確定/リバランス/集中投資率の実判定ロジックを実装する。
  // 現段階はインターフェースのみ。安全側でHOLD固定。
  return {
    dept:       DEPT,
    agent_name: AGENT_NAME,
    date,
    signal:     'HOLD',
    confidence: 50,
    comment:    '財務戦略部は準備段階のため判断を保留します。',
    recommendation: {
      action:       'HOLD', // HOLD | REDUCE | SELL | REBALANCE
      target_asset: '',
      // amountは買い注文と同じ単位（取得原価相当額・時価ではない）。
      // REDUCE: 削減したい原価額 / SELL: 無視され保有原価全額が使われる（lib/orderManager.processSellSignal参照）
      amount:       0,
      reason:       '未実装（インターフェースのみ）',
    },
  };
}

module.exports = { DEPT, AGENT_NAME, analyze };
