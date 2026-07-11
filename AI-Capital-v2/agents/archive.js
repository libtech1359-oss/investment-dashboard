'use strict';

/**
 * archive.js — 記事アーカイブ（横断インデックス）
 *
 * 目的:
 *   日刊・週刊・月刊・四半期レポートを一元管理するインデックス。
 *   記事生成・パイプライン・publisher.js とは完全独立。
 *
 * 現時点の実装範囲:
 *   - アーカイブレコードのスキーマ定義（buildArchiveMeta）
 *   - 検索関数のインターフェース定義（find系）
 *   - GAS読み書きはすべて TODO
 *
 * 未実装（将来: 有効化時に追加）:
 *   - GAS archives シートへの自動保存
 *   - publisher.js・各レポートとの接続
 *   - 銘柄別・シグナル別・年月・種別検索
 *   - 勝率分析
 *   - note記事一覧生成
 *   - 検索UI・フィルター・集計機能
 */

// ── スキーマ定数 ──────────────────────────────────────────────

const ARCHIVE_SCHEMA_VERSION = '1.0';

/**
 * システムバージョン定数
 * 将来 AI Capital V2.1 / V3 へ更新する際はここを変更する。
 * pipeline_status の分析でバージョン別比較に使用。
 *
 * TODO: 将来は .env / config ファイルから読み込む設計へ移行
 *   例: process.env.SYSTEM_VERSION ?? SYSTEM_VERSION
 */
const SYSTEM_VERSION = 'AI Capital V2';

/**
 * パイプラインステータス定数
 * TODO: 将来 publisher.js の実行結果から自動判定する
 *   'success'  — 正常完了
 *   'warning'  — 一部処理でフォールバックが発生
 *   'error'    — パイプライン異常（記事未生成など）
 */
const PIPELINE_STATUS = {
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR:   'error',
};

/**
 * archives シートの列定義（順序保証）
 * GAS SHEET_DEFS の headers と一致させること。
 */
const ARCHIVE_COLUMNS = [
  'article_id',       // 例: AC-2026-0001 / 2026-W26 / 2026-06 / 2026-Q2
  'article_type',     // 'daily' | 'weekly' | 'monthly' | 'quarterly'
  'report_period',    // 例: '2026-06-26' / '2026-W26' / '2026-06' / '2026-Q2'
  'date',             // 記事生成日 YYYY-MM-DD
  'title',            // 記事タイトル
  'signal',           // 最終シグナル（日刊のみ有効）例: ACCUMULATE
  'target_asset',     // 対象銘柄（日刊のみ有効）例: SOX
  'amount',           // 買付金額（日刊のみ有効）例: 325000
  'note_url',         // note.com 公開URL（公開後に設定）
  'status',           // 'draft' | 'published'
  'system_version',   // 例: 'AI Capital V2'（SYSTEM_VERSION 定数を使用）
  'pipeline_status',  // 'success' | 'warning' | 'error'
  'created_at',       // 登録日時 ISO 8601
];

// ── buildArchiveMeta ──────────────────────────────────────────

/**
 * アーカイブレコードを生成する
 *
 * 各レポートの meta と publish 結果から呼び出す想定。
 * 将来の使用例:
 *   // 日刊
 *   const rec = buildArchiveMeta({
 *     article_id:    'AC-2026-0001',
 *     article_type:  'daily',
 *     report_period: '2026-06-26',
 *     date:          '2026-06-26',
 *     title:         'AI Capital 市場会議 2026-06-26',
 *     signal:        'ACCUMULATE',
 *     target_asset:  'SOX',
 *     amount:        325000,
 *     note_url:      'https://note.com/...',
 *     status:        'published',
 *   });
 *
 *   // 週刊
 *   const rec = buildArchiveMeta({
 *     article_id:    '2026-W26',
 *     article_type:  'weekly',
 *     report_period: '2026-W26',
 *     ...
 *   });
 *
 * @param {object} fields
 * @returns {object} archives レコード
 */
function buildArchiveMeta(fields) {
  const now = new Date().toISOString();
  return {
    article_id:      fields.article_id      ?? '',
    article_type:    fields.article_type    ?? 'daily',
    report_period:   fields.report_period   ?? fields.date ?? '',
    date:            fields.date            ?? '',
    title:           fields.title           ?? '',
    signal:          fields.signal          ?? '',
    target_asset:    fields.target_asset    ?? '',
    amount:          fields.amount          ?? '',
    note_url:        fields.note_url        ?? '',
    status:          fields.status          ?? 'draft',
    system_version:  fields.system_version  ?? SYSTEM_VERSION,
    pipeline_status: fields.pipeline_status ?? PIPELINE_STATUS.SUCCESS,
    created_at:      fields.created_at      ?? now,
  };
}

// ── buildArchiveIndex ─────────────────────────────────────────

/**
 * archives シートの全レコードを取得する
 *
 * TODO: 有効化時に GAS から読み込む
 *   const rows = await sheets.getRows('archives');
 *   return rows;
 *
 * @returns {Promise<object[]>}
 */
async function buildArchiveIndex() {
  // TODO: 実装時は以下を有効化
  // const sheets = require('../lib/sheets');
  // return await sheets.getRows('archives');
  return [];
}

// ── 検索関数 ──────────────────────────────────────────────────

/**
 * article_id で検索する
 * 例: findByArticleId('AC-2026-0001', records)
 *
 * TODO: 将来の拡張
 *   - 部分一致検索（startsWith）
 *   - 複数ID一括検索
 *
 * @param {string}   id
 * @param {object[]} records - buildArchiveIndex() の戻り値
 * @returns {object|null}
 */
function findByArticleId(id, records) {
  return records.find(r => r.article_id === id) ?? null;
}

/**
 * 日付（YYYY-MM-DD）で検索する
 * 例: findByDate('2026-06-26', records)
 *
 * TODO: 将来の拡張
 *   - 年月検索（'2026-06'）
 *   - 日付範囲検索（start, end）
 *   - 週番号検索（'2026-W26'）
 *
 * @param {string}   date    - YYYY-MM-DD
 * @param {object[]} records
 * @returns {object[]}
 */
function findByDate(date, records) {
  return records.filter(r => (r.date ?? '').startsWith(date));
}

/**
 * 記事種別で検索する
 * 例: findByType('daily', records)
 *
 * TODO: 将来の拡張
 *   - 複数種別フィルター
 *   - シグナル別検索（findBySignal）
 *   - 銘柄別検索（findByAsset）
 *   - 勝率分析（analyzeWinRate）
 *
 * @param {'daily'|'weekly'|'monthly'|'quarterly'} type
 * @param {object[]} records
 * @returns {object[]}
 */
function findByType(type, records) {
  return records.filter(r => r.article_type === type);
}

// ── エクスポート ──────────────────────────────────────────────

module.exports = {
  ARCHIVE_COLUMNS,
  buildArchiveMeta,
  buildArchiveIndex,
  findByArticleId,
  findByDate,
  findByType,
};
