'use strict';

/**
 * development.js — 開発ログエージェント
 *
 * 目的:
 *   AI Capital の開発履歴を時系列で記録する。
 *   日刊・週刊・月刊・四半期と同じ { log, meta } インターフェースで統一。
 *
 * 現時点の実装範囲:
 *   - logId / buildDevelopmentMeta / buildDevelopmentLog のインターフェース定義
 *   - development_logs シートへの保存（sheets.appendRow）
 *   - 初回ログデータの定義（PHASE1_COMPLETION）
 *
 * 未実装（将来: 有効化時に追加）:
 *   - Git コミット風タイムライン生成
 *   - 開発年表 / Version History ページ生成
 *   - note.com 開発秘話記事の自動生成
 *   - 変更履歴の自動生成（git log 連携）
 *   - publisher.js / scheduler.js への組み込み
 *   - 開発ダッシュボード表示
 */

const sheets = require('../lib/sheets');
const crypto = require('crypto');

// ── フェーズ定数 ─────────────────────────────────────────────
// 将来の phase 追加はここへ追記するだけで対応可能（switch 不要）。

const PHASES = {
  PHASE1:         'Phase 1',
  PHASE2:         'Phase 2',
  PHASE3:         'Phase 3',
  BUG_FIX:        'Bug Fix',
  REFACTOR:       'Refactor',
  INFRASTRUCTURE: 'Infrastructure',
};

// ── ステータス定数 ────────────────────────────────────────────

const STATUS = {
  COMPLETED:   'completed',
  IN_PROGRESS: 'in_progress',
  PLANNED:     'planned',
};

// ── システムバージョン（capitalEvents と同じ定数を再定義して独立性を保つ）──

const SYSTEM_VERSION = 'AI Capital V2';

// ── 初回ログデータ ────────────────────────────────────────────

const PHASE1_COMPLETION = {
  phase:          PHASES.PHASE1,
  title:          'Phase 1 完了・正式運用開始',
  summary:        [
    'AI社員会議システム完成',
    '日刊記事生成完成',
    'X投稿生成完成',
    '資金管理システム完成',
    '月次積立・賞与システム完成',
    '週刊・月刊・四半期レポートの土台完成',
    'アーカイブ機能の土台完成',
    '正式運用フェーズへ移行',
  ].join(' / '),
  changes:        'capital_events, development_logs, archives, weekly_articles, monthly_articles, quarterly_articles シート追加',
  status:         STATUS.COMPLETED,
  system_version: SYSTEM_VERSION,
};

// ── ユーティリティ ────────────────────────────────────────────

function generateLogId() {
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `LOG-${date}-${rand}`;
}

function todayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function nowJSTTimestamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ');
}

// ── メタデータ ────────────────────────────────────────────────

/**
 * 開発ログのメタデータを生成する
 * @param {object} fields
 * @param {string} fields.phase          - PHASES 定数を使用
 * @param {string} fields.title          - ログタイトル
 * @param {string} fields.status         - STATUS 定数を使用
 * @param {string} [fields.date]         - YYYY-MM-DD（省略時は当日JST）
 * @param {string} [fields.log_id]       - 省略時は自動生成
 * @param {string} [fields.system_version]
 * @returns {object}
 */
function buildDevelopmentMeta(fields) {
  return {
    log_id:         fields.log_id         ?? generateLogId(),
    date:           fields.date           ?? todayJST(),
    phase:          fields.phase          ?? PHASES.PHASE1,
    title:          fields.title          ?? '',
    status:         fields.status         ?? STATUS.COMPLETED,
    system_version: fields.system_version ?? SYSTEM_VERSION,
    created_at:     fields.created_at     ?? nowJSTTimestamp(),
  };
}

// ── メイン ────────────────────────────────────────────────────

/**
 * 開発ログを組み立てる
 * 他レポートとの統一インターフェース: { log, meta }
 *
 * 将来の使用例:
 *   const { log, meta } = await buildDevelopmentLog(PHASE1_COMPLETION, '2026-06-28');
 *   await sheets.appendRow('development_logs', { ...meta, summary: log.summary, changes: log.changes });
 *
 * @param {object} fields - PHASE1_COMPLETION などのログデータオブジェクト
 * @param {string} [date] - YYYY-MM-DD（省略時は当日JST）
 * @returns {{ log: object, meta: object }}
 */
async function buildDevelopmentLog(fields, date) {
  const meta = buildDevelopmentMeta({ ...fields, date: date ?? fields.date ?? todayJST() });

  const log = {
    summary: fields.summary ?? '',
    changes: fields.changes ?? '',
  };

  return { log, meta };
}

/**
 * 開発ログを development_logs シートへ保存する
 *
 * TODO: 将来は publisher.js や特定のスラッシュコマンドから呼ぶ
 *
 * @param {object} fields - ログデータ
 * @param {string} [date] - YYYY-MM-DD
 * @returns {Promise<{ log: object, meta: object }>}
 */
async function saveDevelopmentLog(fields, date) {
  const { log, meta } = await buildDevelopmentLog(fields, date);

  await sheets.appendRow('development_logs', {
    log_id:         meta.log_id,
    date:           meta.date,
    phase:          meta.phase,
    title:          meta.title,
    summary:        log.summary,
    changes:        log.changes,
    status:         meta.status,
    system_version: meta.system_version,
    created_at:     meta.created_at,
  });

  console.log(`[development] 開発ログ保存: ${meta.log_id} [${meta.phase}] ${meta.title}`);
  return { log, meta };
}

// ── エクスポート ──────────────────────────────────────────────

module.exports = {
  PHASES,
  STATUS,
  SYSTEM_VERSION,
  PHASE1_COMPLETION,
  buildDevelopmentMeta,
  buildDevelopmentLog,
  saveDevelopmentLog,
};
