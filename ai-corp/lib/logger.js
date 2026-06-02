'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

// ── 日付・時刻ヘルパー ─────────────────────────────────────
function nowISO()  { return new Date().toISOString(); }
function dateStr() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); }
function logFile() { return path.join(LOG_DIR, `${dateStr()}.jsonl`); }

function elapsed(startISO) {
  return Math.round(new Date() - new Date(startISO));
}

// ── セッション生成 ─────────────────────────────────────────

/**
 * 1回の CEO 指示に対するログセッションを開始する
 * @param {string} instruction
 * @param {string} [taskId]
 * @returns {Session}
 */
function start(instruction, taskId = null) {
  const session = {
    id:          nowISO(),
    taskId,
    instruction,
    startAt:     nowISO(),
    steps:       {},
    finalReport: null,
    error:       null,
    totalMs:     null,

    // ── ステップ記録メソッド ──

    dataFetch(context) {
      this.steps.dataFetch = {
        completedAt: nowISO(),
        elapsedMs:   elapsed(this.startAt),
        context,
      };
      _log('[data]', `取得完了 (${this.steps.dataFetch.elapsedMs}ms)`);
      return this;
    },

    decompose(briefing) {
      const prev = this.steps.dataFetch?.completedAt || this.startAt;
      this.steps.decompose = {
        completedAt: nowISO(),
        elapsedMs:   elapsed(prev),
        briefing,
      };
      _log('[secretary]', `タスク分解完了 (${this.steps.decompose.elapsedMs}ms)`);
      return this;
    },

    agent(dept, context, response, elapsedMs) {
      if (!this.steps.agents) this.steps.agents = {};
      this.steps.agents[dept] = { completedAt: nowISO(), elapsedMs, context, response };
      _log(`[${dept}]`, `分析完了 (${elapsedMs}ms)`);
      return this;
    },

    synthesize(report) {
      const prev = Object.values(this.steps.agents || {}).map(a => a.completedAt).sort().pop() || this.startAt;
      this.steps.synthesize = {
        completedAt: nowISO(),
        elapsedMs:   elapsed(prev),
        report,
      };
      _log('[secretary]', `統合完了 (${this.steps.synthesize.elapsedMs}ms)`);
      return this;
    },

    setError(err) {
      this.error = { message: err.message, stack: err.stack, at: nowISO() };
      _log('[ERROR]', err.message);
      return this;
    },

    finish() {
      this.totalMs     = elapsed(this.startAt);
      this.finalReport = this.steps.synthesize?.report || null;
      _save(this);
      _log('[session]', `完了 合計${this.totalMs}ms → ${logFile()}`);
      return this;
    },
  };

  _log('[session]', `開始: ${instruction.slice(0, 60)}...`);
  return session;
}

// ── 内部ヘルパー ──────────────────────────────────────────

function _log(label, msg) {
  const ts = new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
  console.log(`${ts} ${label} ${msg}`);
}

function _save(session) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify(session) + '\n';
    fs.appendFileSync(logFile(), line, 'utf8');
  } catch (e) {
    console.error('[logger] 保存失敗:', e.message);
  }
}

// ── ログ参照ユーティリティ ────────────────────────────────

/**
 * 指定日のログを読んで整形表示する
 * @param {string} date  'YYYY-MM-DD' 省略時は今日
 * @returns {object[]}
 */
function readLogs(date) {
  const file = path.join(LOG_DIR, `${date || dateStr()}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

/**
 * 90日より古いログファイルを削除する（起動時に呼ぶ）
 */
function purgeOldLogs(keepDays = 90) {
  if (!fs.existsSync(LOG_DIR)) return;
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const files  = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl'));
  let removed  = 0;
  files.forEach(f => {
    const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!dateMatch) return;
    if (new Date(dateMatch[1]).getTime() < cutoff) {
      fs.unlinkSync(path.join(LOG_DIR, f));
      removed++;
    }
  });
  if (removed > 0) _log('[logger]', `古いログを ${removed} 件削除（${keepDays}日以上前）`);
}

module.exports = { start, readLogs, purgeOldLogs };
