'use strict';

/**
 * config/financeStrategy.js — 財務戦略部 解放条件
 *
 * 財務戦略部（利益確定・リバランス・現金比率管理）は「AI Capital 組織改編」で
 * 正式公開するまで無効の隠し部署。以下のいずれかを満たすまでisEnabled()はfalseを返す。
 *   - .env で FINANCE_STRATEGY_ENABLED=true を設定
 *   - 現金残高が CASH_THRESHOLD 以上
 * 条件はここでのみ管理し、呼び出し側にハードコードしない。
 */

const CASH_THRESHOLD = Number(process.env.FINANCE_STRATEGY_CASH_THRESHOLD || 3000000);

function isEnabled(cash = 0) {
  if (process.env.FINANCE_STRATEGY_ENABLED === 'true') return true;
  return Number(cash) >= CASH_THRESHOLD;
}

module.exports = { isEnabled, CASH_THRESHOLD };
