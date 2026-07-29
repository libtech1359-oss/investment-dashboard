'use strict';

/**
 * development.js — 開発ログエージェント
 *
 * 目的:
 *   AI Capital の開発履歴を時系列で記録する。人手で saveDevelopmentLog() を
 *   呼ぶ運用は前提にしない — scripts/auto-devlog.js が git の post-commit フックから
 *   自動で呼び出す（詳細は同ファイルとリポジトリルートの .git/hooks/post-commit を参照）。
 *   このファイルは「保存先のスキーマとルール」を定義する場所であり、
 *   「いつ何を記録するか」の判断は lib/changeClassifier.js が担う。
 *
 * development_logs シートの列:
 *   log_id | date | type | title | summary | affected_files | reason |
 *   impact | breaking_change | version | status | system_version | created_at
 *
 *   type            - MAJOR_EVENT_TYPES のいずれか、または 'OTHER'
 *   affected_files  - 変更されたファイル一覧（カンマ区切り）
 *   reason          - なぜその変更をしたか（コミット本文、無ければ自動検出ルールの説明）
 *   impact          - 'high' | 'medium' | 'low'（コアファイルへの重大変更ほど高い）
 *   breaking_change - 既存ロジックを置き換える破壊的変更かどうか（真偽値）
 *   version         - この変更が反映された時点の AI Capital バージョン（lib/systemVersion.js）
 *   status          - 'auto_detected'（自動検出） | 'manual'（人が明示的に記録）
 */

const sheets = require('../lib/sheets');
const crypto = require('crypto');

// ── システムバージョン表示ラベル ────────────────────────────────
// 実際のバージョン番号の正本は config/systemVersion.json（lib/systemVersion.js が管理）。
// development_logs の system_version 列には「どのシステム世代のログか」という
// 大分類（AI Capital V2）を書く。細かいバージョン番号は version 列で管理する。

const SYSTEM_VERSION = 'AI Capital V2';

// ── Weekly記事へ自動反映される「重大イベント」カテゴリ ────────────
//
// lib/changeClassifier.js が git diff からこれらのキーのいずれかに分類すると、
// scripts/auto-devlog.js が development_logs へ記録すると同時に
// lib/systemVersion.bumpMinor() でバージョンを上げ、lib/changelog.js で
// CHANGELOG.md を更新する。分類できない変更は type: 'OTHER' として記録される
// （バージョンは上げず、CHANGELOGにも載せない — development_logs内の監査証跡のみ）。
//
// agents/weekly.js の週刊記事はこの development_logs を参照し、①②⑧⑩へ自動反映する。
// 人がこの定数へ触れる必要があるのは「新しいイベント種別を追加したい時」だけであり、
// 通常運用でここを編集する必要はない。
const MAJOR_EVENT_TYPES = {
  PHILOSOPHY:   '投資哲学変更',
  RULE_ENGINE:  'Rule Engine変更',
  EVAL_LOGIC:   '評価ロジック変更',
  VALIDATOR:    'Validator追加',
  NEW_ASSET:    '候補資産追加',
  NEW_DEPT:     '部署追加',
  NEW_STAFF:    'AI社員追加',
  MAJOR_BUGFIX: '重大バグ修正',
  MAJOR_EVENT:  '大型イベント',
};

const MAJOR_EVENT_TYPE_VALUES = Object.values(MAJOR_EVENT_TYPES);

/**
 * development_logs の type 値が「Weekly記事へ自動反映すべき重大イベント」か判定する
 * @param {string} type
 * @returns {boolean}
 */
function isMajorEvent(type) {
  return MAJOR_EVENT_TYPE_VALUES.includes(type);
}

// ── ステータス定数 ────────────────────────────────────────────

const STATUS = {
  AUTO_DETECTED: 'auto_detected', // scripts/auto-devlog.js による自動記録（コード変更）
  MANUAL:        'manual',        // 人・AIエージェントが明示的に記録した過去分
  AUTO_QUALITY:  'auto_quality',  // publisher.js の品質改善ループ/編集長レビューによる自動記録（記事品質。Phase4）
};

// ── 記事品質イベント種別（Weekly自動反映の対象外・development_logsの監査証跡専用） ──
// MAJOR_EVENT_TYPESとは異なり、これらはコード変更ではなく記事品質の変化を記録する。
// isMajorEvent()の対象に含めないため、バージョン更新・CHANGELOG反映・Weekly本文への
// 自動転記は発生しない（agents/weekly.jsの品質セクションはquality_scoresを直接参照する）。
const QUALITY_EVENT_TYPES = {
  QUALITY_IMPROVEMENT: 'QUALITY_IMPROVEMENT', // 前回記録比でtotal_scoreが向上
  EDITOR_REJECTION:     'EDITOR_REJECTION',    // AI編集長が「公開を推奨しません」と判定
  CHART_GENERATION_INCOMPLETE: 'CHART_GENERATION_INCOMPLETE', // グラフ生成が2枚未満（公開停止）
  CHART_EMBED_INCOMPLETE:      'CHART_EMBED_INCOMPLETE',      // グラフ生成は2枚だが記事への埋め込みが2枚未満
};

// ── 初回ログデータ（このシステム自体の記録は手動記録として残す） ────

const BOOTSTRAP_LOG = {
  type:            MAJOR_EVENT_TYPES.MAJOR_EVENT,
  title:           'Phase 1 完了・正式運用開始',
  summary:         [
    'AI社員会議システム完成',
    '日刊記事生成完成',
    'X投稿生成完成',
    '資金管理システム完成',
    '月次積立・賞与システム完成',
    '週刊・月刊・四半期レポートの土台完成',
    'アーカイブ機能の土台完成',
    '正式運用フェーズへ移行',
  ].join(' / '),
  affected_files:  'capital_events, development_logs, archives, weekly_articles, monthly_articles, quarterly_articles',
  reason:          '正式運用フェーズへの移行に伴うデータ基盤整備',
  impact:          'high',
  breaking_change: false,
  status:          STATUS.MANUAL,
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
 * @param {string} [fields.date]         - YYYY-MM-DD（省略時は当日JST）
 * @param {string} [fields.log_id]       - 省略時は自動生成
 * @param {string} [fields.status]       - STATUS 定数を使用（省略時は STATUS.MANUAL）
 * @param {string} [fields.system_version]
 * @returns {object}
 */
function buildDevelopmentMeta(fields) {
  return {
    log_id:         fields.log_id         ?? generateLogId(),
    date:           fields.date           ?? todayJST(),
    status:         fields.status         ?? STATUS.MANUAL,
    system_version: fields.system_version ?? SYSTEM_VERSION,
    created_at:     fields.created_at     ?? nowJSTTimestamp(),
  };
}

// ── メイン ────────────────────────────────────────────────────

/**
 * 開発ログを組み立てる（{ log, meta } の統一インターフェース）
 * @param {object} fields - type/title/summary/affected_files/reason/impact/breaking_change/version
 * @param {string} [date] - YYYY-MM-DD（省略時は当日JST）
 * @returns {Promise<{ log: object, meta: object }>}
 */
async function buildDevelopmentLog(fields, date) {
  const meta = buildDevelopmentMeta({ ...fields, date: date ?? fields.date ?? todayJST() });

  const log = {
    type:            fields.type            ?? 'OTHER',
    title:           fields.title           ?? '',
    summary:         fields.summary         ?? '',
    affected_files:  fields.affected_files  ?? '',
    reason:          fields.reason          ?? '',
    impact:          fields.impact          ?? 'low',
    breaking_change: fields.breaking_change ?? false,
    version:         fields.version         ?? '',
  };

  return { log, meta };
}

/**
 * 開発ログを development_logs シートへ保存する。
 * scripts/auto-devlog.js（git post-commitフック経由）から自動的に呼ばれるのが標準経路。
 * 過去分の手動登録や、フックが使えない環境での補完記録にも使える。
 *
 * @param {object} fields - ログデータ
 * @param {string} [date] - YYYY-MM-DD
 * @returns {Promise<{ log: object, meta: object }>}
 */
async function saveDevelopmentLog(fields, date) {
  const { log, meta } = await buildDevelopmentLog(fields, date);

  await sheets.appendRow('development_logs', {
    log_id:          meta.log_id,
    date:            meta.date,
    type:            log.type,
    title:           log.title,
    summary:         log.summary,
    affected_files:  log.affected_files,
    reason:          log.reason,
    impact:          log.impact,
    breaking_change: String(log.breaking_change),
    version:         log.version,
    status:          meta.status,
    system_version:  meta.system_version,
    created_at:      meta.created_at,
  });

  console.log(`[development] 開発ログ保存: ${meta.log_id} [${log.type}] ${log.title}`);
  return { log, meta };
}

// ── エクスポート ──────────────────────────────────────────────

module.exports = {
  STATUS,
  SYSTEM_VERSION,
  MAJOR_EVENT_TYPES,
  QUALITY_EVENT_TYPES,
  BOOTSTRAP_LOG,
  buildDevelopmentMeta,
  buildDevelopmentLog,
  saveDevelopmentLog,
  isMajorEvent,
};
