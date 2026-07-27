'use strict';

/**
 * qualityTracker.js — 記事品質管理（正式運用）
 *
 * 記事生成後に recordQuality() を呼ぶと quality_status シートへ結果を保存し、
 * 連続 PASS 日数を自動管理する。
 *
 * record_type（Phase3・AUTO/AUTO_RETRY/MANUALの3値）:
 *   - AUTO       - 初回生成が機械修正・LLM再生成なしでそのままValidatorを通過
 *   - AUTO_RETRY - publish()内の品質改善ループ（機械修正 and/or LLM再生成）を経て
 *                  Validatorを通過。人間の介入なし＝完全自律の範囲内。
 *   - MANUAL     - 同日付で publish() が複数回呼ばれたことを検知（＝誰かが手動で
 *                  パイプラインを再実行した）、または note.com上での手動編集など
 *                  自動検知できないケースでシートの record_type セルを直接 MANUAL に
 *                  書き換える運用。品質改善ループ内の再試行はここに含まれない。
 *
 * manual_fix 列（後方互換用）は record_type === 'MANUAL' ? 'FAIL' : 'PASS' の派生値。
 *
 * consecutive_pass 加算条件:
 *   overall === 'PASS' かつ record_type !== 'MANUAL' の場合のみ +1
 *   （AUTO_RETRYは自律的な自己修正のため連続日数を切らない。MANUALのみリセット対象）
 */

const sheets = require('./sheets');
const { scoreArticle, withEditorScore } = require('./qualityScorer');
const development = require('../agents/development');

// quality_scores の対象カテゴリ（development_logsへの品質改善検知で使う）
const QUALITY_CATEGORY_LABELS = {
  layout_score:      'レイアウト',
  japanese_score:    '日本語品質',
  logic_score:       '投資ロジック',
  department_score:  '部署人格',
  validator_score:   'Validator',
  editor_score:      '編集長評価',
};

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
    layout:         hasRule(8,9,10,26,27,28,29,30,31) ? 'FAIL' : 'PASS',   // 重複/Markdown/空セクション/箇条書き/改行崩れ/文重複/句読点/見出し空行/絵文字
  };
}

// ── 品質記録 ─────────────────────────────────────────────────

/**
 * 記事生成後に呼ぶ。quality_status シートへ 1 行追加し、連続 PASS 日数を返す。
 *
 * @param {{ date, articleNum, validation, chartsOk, regenerationCount, mechanicalFixCount, editorReview }} opts
 *   editorReview - lib/editorReview.runEditorReview() の返り値（未実施の場合は省略可）
 * @returns {Promise<{ overall: string, record_type: string, manual_fix: string, consecutive_pass: number, score: object }>}
 */
async function recordQuality({ date, articleNum, validation, chartsOk, regenerationCount = 0, mechanicalFixCount = 0, editorReview = null }) {
  const checks     = deriveChecks(validation, chartsOk);
  const overall    = Object.values(checks).every(v => v === 'PASS') ? 'PASS' : 'FAIL';
  const baseScore  = scoreArticle(validation, regenerationCount);
  const score      = (editorReview && editorReview.editorScore != null)
    ? withEditorScore(baseScore, editorReview.editorScore)
    : baseScore;

  // 既存レコードを取得（連続日数 + 同日複数回publish()検知に使用）
  let prevRows   = [];
  let prevStreak = 0;
  try {
    prevRows   = await sheets.getRows('quality_status');
    const lastRow = prevRows.length > 0 ? prevRows[prevRows.length - 1] : null;
    prevStreak = lastRow ? parseInt(lastRow.consecutive_pass ?? 0) : 0;
  } catch {
    // シート未作成など — 0 からスタート
  }

  // record_type の自動判定（AUTO / AUTO_RETRY / MANUAL）
  // 同日付レコードが既に存在する場合のみ MANUAL とみなす（= publish()自体が同日に複数回
  // 呼ばれた＝誰かが手動でパイプラインを再実行した）。品質改善ループ内の機械修正・LLM再生成は
  // 同一のpublish()呼び出し内で完結し、recordQuality()はループ終了後に1回だけ呼ばれるため、
  // ここでは自動再試行と手動再実行を混同しない。
  const alreadyRecorded = prevRows.some(r => r.date === date);
  const recordType = alreadyRecorded
    ? 'MANUAL'
    : (mechanicalFixCount > 0 || regenerationCount > 0) ? 'AUTO_RETRY' : 'AUTO';
  const manualFix = recordType === 'MANUAL' ? 'FAIL' : 'PASS'; // 後方互換列

  if (alreadyRecorded) {
    console.log(`[qualityTracker] 同日複数回のpublish()呼び出しを検知 (${date}) → record_type = MANUAL`);
  } else if (recordType === 'AUTO_RETRY') {
    console.log(`[qualityTracker] 品質改善ループで最終化 (${date}) → record_type = AUTO_RETRY（機械修正${mechanicalFixCount}回・LLM再生成${regenerationCount}回）`);
  }

  // 連続 PASS 条件: overall=PASS かつ MANUALでない場合のみ +1（AUTO_RETRYは自律的な自己修正のため継続扱い）
  const fullPass  = overall === 'PASS' && recordType !== 'MANUAL';
  const newStreak = fullPass ? prevStreak + 1 : 0;

  // note 列の文言
  let noteText;
  if (fullPass) {
    noteText = recordType === 'AUTO_RETRY'
      ? `品質PASS（自動修正 機械${mechanicalFixCount}回/LLM${regenerationCount}回・連続${newStreak}日）`
      : `品質PASS（連続${newStreak}日）`;
  } else if (recordType === 'MANUAL') {
    noteText = `品質FAIL（人間の介入を検知・連続${prevStreak}日→リセット）`;
  } else {
    noteText = `品質FAIL（品質${overall}・連続${prevStreak}日→リセット）`;
  }

  try {
    await sheets.appendRow('quality_status', {
      date,
      article_id:       articleNum,
      ...checks,
      overall,
      manual_fix:       manualFix,
      record_type:      recordType,
      consecutive_pass: String(newStreak),
      note:             noteText,
    });
    console.log(
      `[qualityTracker] 品質記録完了: overall=${overall} record_type=${recordType} 連続${newStreak}日`
    );
  } catch (err) {
    console.warn(`[qualityTracker] quality_status への書き込み失敗: ${err.message}`);
    console.warn('[qualityTracker] ヒント: clasp push → node _setup_gas.js を実行してシートを作成してください（record_type列追加済み）');
  }

  const qualityRow = {
    date,
    article_id:          articleNum,
    layout_score:         String(score.layout),
    japanese_score:       String(score.japanese),
    logic_score:          String(score.logic),
    department_score:     String(score.department),
    validator_score:      String(score.validator),
    editor_score:         editorReview && editorReview.editorScore != null ? String(editorReview.editorScore) : '',
    total_score:          String(score.total),
    warning_count:        String(score.warningCount),
    regeneration_count:   String(regenerationCount),
    mechanical_fix_count: String(mechanicalFixCount),
    editor_comment:       editorReview?.comment ?? '',
    publish_decision:     editorReview ? (editorReview.verdict === 'APPROVED' ? 'APPROVED' : 'REJECTED') : '',
    created_at:           new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' '),
  };

  try {
    await sheets.appendRow('quality_scores', qualityRow);
    console.log(`[qualityTracker] 品質スコア記録: total=${score.total}点 (layout=${score.layout} japanese=${score.japanese} logic=${score.logic} department=${score.department} validator=${score.validator}${editorReview?.editorScore != null ? ` editor=${editorReview.editorScore}` : ''})`);
  } catch (err) {
    console.warn(`[qualityTracker] quality_scores への書き込み失敗: ${err.message}`);
    console.warn('[qualityTracker] ヒント: clasp push → node _setup_gas.js を実行してシートを作成してください（quality_scoresシート追加済み）');
  }

  // ── 品質改善の自動検知（実装⑥） ────────────────────────────
  // 直前のquality_scoresレコード（同日を除く直近1件）と比べてtotal_scoreが向上していれば、
  // development_logsへ改善内容を自動記録する（カテゴリ別の伸び幅も併記）。
  try {
    const prevScoreRows = await sheets.getRows('quality_scores');
    const prevRow = [...prevScoreRows].reverse().find(r => r.date !== date);
    if (prevRow) {
      const prevTotal = parseFloat(prevRow.total_score ?? 0);
      const delta     = score.total - prevTotal;
      if (delta > 0) {
        const categoryDeltas = Object.entries(QUALITY_CATEGORY_LABELS)
          .map(([key, label]) => {
            const curVal  = key === 'editor_score' ? score.editor : score[key.replace('_score', '')];
            const prevVal = parseFloat(prevRow[key]);
            if (curVal == null || isNaN(prevVal)) return null;
            const d = curVal - prevVal;
            return d > 0 ? `${label}：+${d}点` : null;
          })
          .filter(Boolean);

        await development.saveDevelopmentLog({
          type:    development.QUALITY_EVENT_TYPES.QUALITY_IMPROVEMENT,
          title:   `記事品質改善（${prevRow.article_id ?? prevRow.date} → ${articleNum}）`,
          summary: `総合スコア ${prevTotal}→${score.total}（+${delta}）${categoryDeltas.length ? '。' + categoryDeltas.join('、') : ''}`,
          affected_files: 'quality_scores',
          reason:  '品質改善ループ・AI編集長レビューの結果、前回記録より品質スコアが向上',
          impact:  'low',
          breaking_change: false,
          status:  development.STATUS.AUTO_QUALITY,
        }, date);
      }
    }
  } catch (err) {
    console.warn(`[qualityTracker] 品質改善ログ記録スキップ: ${err.message}`);
  }

  return { overall, record_type: recordType, manual_fix: manualFix, consecutive_pass: newStreak, score };
}

// ── コンソール進捗表示 ────────────────────────────────────────

/**
 * 品質チェックの結果バナーを返す（console.log で表示）。
 *
 * @param {string} overall         - 'PASS' | 'FAIL'
 * @param {string} recordType      - 'AUTO' | 'AUTO_RETRY' | 'MANUAL'
 * @param {number} consecutivePass - 最新の連続 PASS 日数
 * @param {object} [score]         - qualityScorer.scoreArticle() の返り値（省略可）
 * @returns {string}
 */
function buildProgressLog(overall, recordType, consecutivePass, score) {
  const SEP        = '━'.repeat(20);
  const fullPass    = overall === 'PASS' && recordType !== 'MANUAL';
  const scoreLines  = score
    ? ['', `総合スコア：${score.total}点（layout${score.layout} japanese${score.japanese} logic${score.logic} department${score.department} validator${score.validator}${score.editor != null ? ` editor${score.editor}` : ''}）`]
    : [];

  if (fullPass) {
    const recordLine = recordType === 'AUTO_RETRY' ? '区分：AUTO_RETRY（自動修正で解決）' : '区分：AUTO';
    return [
      '', SEP, '',
      '品質チェック', '',
      `品質：PASS（連続${consecutivePass}日）`, '',
      recordLine,
      ...scoreLines, '',
      SEP, '',
    ].join('\n');
  }

  // overall FAIL または record_type=MANUAL — リセット表示
  const qualityLine = `品質：${overall}`;
  const recordLine  = `区分：${recordType}${recordType === 'MANUAL' ? '（人間の介入を検知）' : ''}`;

  return [
    '', SEP, '',
    '品質チェック', '',
    qualityLine, '',
    recordLine,
    ...scoreLines, '',
    '連続PASSは0日にリセットされました', '',
    SEP, '',
  ].join('\n');
}

module.exports = { recordQuality, buildProgressLog };
