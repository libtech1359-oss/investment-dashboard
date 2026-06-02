'use strict';

/**
 * core/logger.js
 *
 * エージェント別テキストログ
 * logs/{agent}/YYYY-MM-DD.log に追記
 *
 * 使い方:
 *   const { writeLog, writeError } = require('../core/logger');
 *   writeLog('market', 'NASDAQ分析開始');
 *   writeError('risk', err);
 */

const fs   = require('fs');
const path = require('path');

const LOG_ROOT = path.join(__dirname, '..', 'logs');

// ── 内部ヘルパー ───────────────────────────────────────────

function dateStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function timeStr() {
  return new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function append(file, line) {
  fs.appendFileSync(file, line, 'utf8');
}

// ── 公開 API ───────────────────────────────────────────────

/**
 * エージェント別ログに書き込む
 * @param {string} agent   'secretary' | 'market' | 'portfolio' | 'risk'
 * @param {string} message ログメッセージ
 * @param {string} [taskId] タスクID（省略可）
 */
function writeLog(agent, message, taskId = null) {
  const dir  = path.join(LOG_ROOT, agent);
  const file = path.join(dir, `${dateStr()}.log`);
  const tag  = taskId ? ` [${taskId}]` : '';
  const line = `[${timeStr()}]${tag} ${message}\n`;

  ensureDir(dir);
  append(file, line);
  console.log(`[${agent}]${tag} ${message}`);
}

/**
 * エラーをエージェント別 + errors/ 両方に書き込む
 * @param {string}         agent エラーが発生した部署
 * @param {Error | string} err   エラーオブジェクト（stack推奨）
 * @param {string}         [taskId] タスクID（省略可）
 */
function writeError(agent, err, taskId = null) {
  const stack    = err instanceof Error ? err.stack : String(err);
  const message  = err instanceof Error ? err.message : String(err);
  const tag      = taskId ? ` [${taskId}]` : '';
  const line     = `[${timeStr()}]${tag} [ERROR] ${stack}\n`;
  const errDir   = path.join(LOG_ROOT, 'errors');
  const agentDir = path.join(LOG_ROOT, agent);

  // errors/ にも記録（横断的に異常を追いやすくする）
  ensureDir(errDir);
  append(path.join(errDir, `${dateStr()}.log`), `[${agent}] ${line}`);

  // エージェント別にも記録
  ensureDir(agentDir);
  append(path.join(agentDir, `${dateStr()}.log`), line);

  console.error(`[${agent}] [ERROR] ${message}`);
}

module.exports = { writeLog, writeError };
