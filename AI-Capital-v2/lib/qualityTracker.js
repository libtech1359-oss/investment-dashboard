'use strict';

/**
 * qualityTracker.js — 公開リハーサル品質管理
 *
 * 記事生成後に recordQuality() を呼ぶと quality_status シートへ結果を保存し、
 * 連続 PASS 日数を自動管理する。
 *
 * manual_fix の自動判定:
 *   - 同日付のレコードが既に存在する → 再生成（コード修正後の再実行）= FAIL
 *   - 存在しない → 初回生成 = PASS
 *   - note.com上での手動編集など自動検知できないケースは
 *     シートの manual_fix セルを直接 FAIL に変更する運用とする
 *
 * consecutive_pass 加算条件:
 *   overall === 'PASS' かつ manual_fix === 'PASS' の両方が揃った場合のみ +1
 */

const sheets = require('./sheets');

const GOAL_DAYS = 7;

// ── 個別チェック結果を validator の警告から導出 ──────────────

/**
 * validateArticle() の結果を列ごとの PASS/FAIL に変換する。
 * Rule 番号は articleValidator.js の warn() が付与する接頭辞に依存する。
 */
function deriveChecks(validation, chartsOk) {
  const hasRule = (...nums) => validation.warnings.some(w =>
    nums.some(n => w.startsWith(`❌ Rule ${String(n).padStart(2, '0')}`))
  );

  return {
    validator:      validation.ok    ? 'PASS' : 'FAIL',
    portfolio:      hasRule(3,4,5,6) ? 'FAIL' : 'PASS',   // 注文中/現金/比率/保有
    orders:         hasRule(3)       ? 'FAIL' : 'PASS',   // 注文中資金・銘柄
    final_decision: hasRule(1,2,7)   ? 'FAIL' : 'PASS',   // 買付候補/部署整合/金額
    capital_events: hasRule(4)       ? 'FAIL' : 'PASS',   // portfolio内部整合が間接指標
    charts:         chartsOk         ? 'PASS' : 'FAIL',
    layout:         hasRule(8,9,10)  ? 'FAIL' : 'PASS',   // 重複/Markdown/空セクション
  };
}

// ── 品質記録 ─────────────────────────────────────────────────

/**
 * 記事生成後に呼ぶ。quality_status シートへ 1 行追加し、連続 PASS 日数を返す。
 *
 * @param {{ date, articleNum, validation, chartsOk }} opts
 * @returns {Promise<{ overall: string, manual_fix: string, consecutive_pass: number }>}
 */
async function recordQuality({ date, articleNum, validation, chartsOk }) {
  const checks  = deriveChecks(validation, chartsOk);
  const overall = Object.values(checks).every(v => v === 'PASS') ? 'PASS' : 'FAIL';

  // 既存レコードを取得（連続日数 + 再生成検知に使用）
  let prevRows   = [];
  let prevStreak = 0;
  try {
    prevRows   = await sheets.getRows('quality_status');
    const lastRow = prevRows.length > 0 ? prevRows[prevRows.length - 1] : null;
    prevStreak = lastRow ? parseInt(lastRow.consecutive_pass ?? 0) : 0;
  } catch {
    // シート未作成など — 0 からスタート
  }

  // 同日付レコードの有無で manual_fix を自動判定
  // 同日に既にレコードがある = コード修正による再生成 → FAIL
  const alreadyRecorded = prevRows.some(r => r.date === date);
  const manualFix = alreadyRecorded ? 'FAIL' : 'PASS';

  if (alreadyRecorded) {
    console.log(`[qualityTracker] 同日再生成を検知 (${date}) → manual_fix = FAIL`);
  }

  // 連続 PASS 条件: overall=PASS かつ manual_fix=PASS の両方が必要
  const fullPass  = overall === 'PASS' && manualFix === 'PASS';
  const newStreak = fullPass ? prevStreak + 1 : 0;

  // note 列の文言
  let noteText;
  if (fullPass) {
    noteText = `公開リハーサル Day${newStreak}`;
  } else if (overall === 'PASS' && manualFix === 'FAIL') {
    noteText = `公開リハーサル FAIL（手動修正あり・連続${prevStreak}日→リセット）`;
  } else {
    noteText = `公開リハーサル FAIL（品質${overall}・連続${prevStreak}日→リセット）`;
  }

  try {
    await sheets.appendRow('quality_status', {
      date,
      article_id:       articleNum,
      ...checks,
      overall,
      manual_fix:       manualFix,
      consecutive_pass: String(newStreak),
      note:             noteText,
    });
    console.log(
      `[qualityTracker] 品質記録完了: overall=${overall} manual_fix=${manualFix} 連続${newStreak}日`
    );
  } catch (err) {
    console.warn(`[qualityTracker] quality_status への書き込み失敗: ${err.message}`);
    console.warn('[qualityTracker] ヒント: clasp push → node _setup_gas.js を実行してシートを作成してください');
  }

  return { overall, manual_fix: manualFix, consecutive_pass: newStreak };
}

// ── コンソール進捗表示 ────────────────────────────────────────

/**
 * 公開リハーサルの進捗バナーを返す（console.log で表示）。
 *
 * @param {string} overall         - 'PASS' | 'FAIL'
 * @param {string} manualFix       - 'PASS' | 'FAIL'
 * @param {number} consecutivePass - 最新の連続 PASS 日数
 * @returns {string}
 */
function buildProgressLog(overall, manualFix, consecutivePass) {
  const SEP       = '━'.repeat(20);
  const fullPass  = overall === 'PASS' && manualFix === 'PASS';
  const remaining = Math.max(0, GOAL_DAYS - consecutivePass);

  if (fullPass) {
    return [
      '', SEP, '',
      '公開リハーサル', '',
      `Day ${consecutivePass} / ${GOAL_DAYS}`, '',
      '品質：PASS', '',
      '手動修正：なし', '',
      `正式公開まであと${remaining}日`, '',
      SEP, '',
    ].join('\n');
  }

  // overall FAIL または manual_fix FAIL — リセット表示
  const qualityLine = `品質：${overall}`;
  const manualLine  = `手動修正：${manualFix === 'PASS' ? 'なし' : 'あり'}`;

  return [
    '', SEP, '',
    '公開リハーサル', '',
    qualityLine, '',
    manualLine, '',
    '連続PASSは0日にリセットされました', '',
    SEP, '',
  ].join('\n');
}

module.exports = { recordQuality, buildProgressLog };
