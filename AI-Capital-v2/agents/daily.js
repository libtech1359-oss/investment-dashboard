'use strict';

/**
 * daily.js — 日刊記事の共通インターフェース層
 *
 * 目的:
 *   publisher.js の動作を一切変えずに、
 *   buildDailyDraft() / buildWeeklyDraft() / buildMonthlyDraft() の
 *   共通インターフェース { note, meta } を日刊記事にも提供する。
 *
 * 使い方:
 *   // publisher.js でノートを生成した後
 *   const result = await publish(date);
 *   const article = buildDailyDraft(result.note, result.date, articleId);
 *   // → { note, meta }
 *
 * publisher.js との関係:
 *   - publisher.js の publish() は変更しない
 *   - 記事生成・note保存・X投稿はすべて publisher.js が担当
 *   - このファイルはメタデータのラッピングのみを担当
 */

// ── メタデータ ────────────────────────────────────────────────

/**
 * 日刊記事のメタデータを生成する
 * @param {string} date      - YYYY-MM-DD
 * @param {string} articleId - 例: 'AC-2026-0001'（省略時は date ベースの仮ID）
 * @returns {object}
 */
function buildDailyMeta(date, articleId) {
  return {
    article_id:     articleId ?? `AC-${date}`,
    article_type:   'daily',
    date,
    generated_at:   null,  // 将来: 生成完了時に ISO 8601 タイムスタンプを設定
    schema_version: '1.0',
  };
}

/**
 * 日刊記事を { note, meta } 形式でラップする
 *
 * publisher.js の publish() が返す note 文字列を受け取り、
 * 週刊・月刊と同じインターフェースに統一する。
 *
 * @param {string} note      - publisher.js が生成した記事本文
 * @param {string} date      - YYYY-MM-DD
 * @param {string} articleId - 例: 'AC-2026-0001'（省略可）
 * @returns {{ note: string, meta: object }}
 */
function buildDailyDraft(note, date, articleId) {
  const meta = buildDailyMeta(date, articleId);
  return { note, meta };
}

module.exports = { buildDailyMeta, buildDailyDraft };
