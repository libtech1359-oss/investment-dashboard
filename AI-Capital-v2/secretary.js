'use strict';

/**
 * secretary.js — パイプラインオーケストレーター
 *
 * 実行順序（厳守）:
 *   1. データ取得・シート書き込み（dataFetcher）
 *   2. 各エージェント分析・投票（market / portfolio / risk）
 *   3. シグナル集約・最終判断（signalAggregator — LLMなし）
 *   4. 発注記録（orderManager）
 *   5. 記事生成（publisher — 最終工程）
 */

const dataFetcher      = require('./lib/dataFetcher');
const signalAggregator = require('./lib/signalAggregator');
const orderManager     = require('./lib/orderManager');
const market           = require('./agents/market');
const portfolio        = require('./agents/portfolio');
const risk             = require('./agents/risk');
const audit            = require('./agents/audit');
const publisher        = require('./agents/publisher');

function todayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/**
 * メイン実行パイプライン
 * @param {object} opts
 * @param {boolean} opts.skipPublish - 記事生成をスキップ（朝会など）
 * @param {Function} opts.onProgress - 進捗コールバック (message) => void
 * @returns {Promise<object>} pipeline result
 */
async function run({ skipPublish = false, onProgress = null } = {}) {
  const date = todayJST();
  const notify = msg => {
    console.log(`[secretary] ${msg}`);
    if (onProgress) onProgress(msg).catch(() => {});
  };

  notify(`パイプライン開始: ${date}`);

  // ── Step 1: データ取得 ──────────────────────────────────────
  notify('Step 1/5 データ取得・市場データ書き込み...');
  let marketRow;
  try {
    marketRow = await dataFetcher.run();
  } catch (err) {
    notify(`Step 1 失敗（続行）: ${err.message}`);
    marketRow = null;
  }

  // ── Step 2a: マーケット/ポートフォリオ/リスク（並列）──────────
  notify('Step 2/5 各部署分析・投票（マーケット/ポートフォリオ/リスク）...');
  const [mktResult, pfResult, riskResult] = await Promise.allSettled([
    market.analyze(date),
    portfolio.analyze(date),
    risk.analyze(date),
  ]);

  if (mktResult.status === 'rejected')  notify(`マーケット部エラー: ${mktResult.reason?.message}`);
  if (pfResult.status === 'rejected')   notify(`ポートフォリオ部エラー: ${pfResult.reason?.message}`);
  if (riskResult.status === 'rejected') notify(`リスク管理部エラー: ${riskResult.reason?.message}`);

  // ── Step 2b: 審査部（鬼塚ガイ）— 他部署の投票を読んでから実行 ──
  notify('Step 2/5 審査部分析・投票...');
  const auditResult = await Promise.allSettled([audit.analyze(date)]).then(r => r[0]);
  if (auditResult.status === 'rejected') notify(`審査部エラー: ${auditResult.reason?.message}`);

  const voteResults = { market: mktResult, portfolio: pfResult, risk: riskResult, audit: auditResult };
  const successCount = [mktResult, pfResult, riskResult, auditResult].filter(r => r.status === 'fulfilled').length;
  notify(`Step 2 完了: ${successCount}/4 エージェント投票成功`);

  // ── Step 3: シグナル集約（LLMなし・機械判定）──────────────
  notify('Step 3/5 シグナル集約（機械判定）...');
  let finalDecision;
  try {
    finalDecision = await signalAggregator.run(date);
    notify(`Step 3 完了: ${finalDecision.final_signal} → ${finalDecision.target_asset || 'なし'} ¥${finalDecision.amount || 0}`);
  } catch (err) {
    notify(`Step 3 失敗: ${err.message}`);
    finalDecision = null;
  }

  // ── Step 3.5: article_decisions 保存（市場コンテキストスナップショット）
  try {
    await dataFetcher.writeArticleDecision(date, finalDecision);
  } catch (err) {
    notify(`article_decisions 保存失敗（続行）: ${err.message}`);
  }

  // ── Step 4: 発注記録 ────────────────────────────────────────
  notify('Step 4/5 発注記録...');
  let order = null;
  try {
    order = await orderManager.processSignal(finalDecision);
    if (order) {
      notify(`Step 4 完了: 注文ID ${order.order_id} ${order.asset_name} ¥${parseInt(order.amount).toLocaleString()}`);
    } else {
      notify('Step 4 完了: 発注なし');
    }
  } catch (err) {
    notify(`Step 4 失敗: ${err.message}`);
  }

  // ── Step 5: 記事生成（最終工程）─────────────────────────────
  let article = null;
  if (!skipPublish) {
    notify('Step 5/5 記事生成（最終工程）...');
    try {
      article = await publisher.publish(date);
      if (article?.validationFailed) {
        const warningsText = (article.validationWarnings || []).join('\n\n');
        notify(`❌ 【審査部】記事公開ブロック: 整合性チェック失敗（${article.validationWarnings.length}件）\n${warningsText}`);
      } else if (article?.chartsIncomplete) {
        notify(`❌ 【グラフ埋め込み】要確認: グラフ生成${article.graphsGenerated}/2 埋め込み${article.graphsEmbedded}/2（note記事 ${article.note.length}字・下書きは保存済み）`);
      } else {
        notify(`Step 5 完了: note記事 ${article.note.length}字`);
      }
    } catch (err) {
      notify(`Step 5 失敗: ${err.message}`);
    }
  } else {
    notify('Step 5/5 記事生成スキップ（skipPublish=true）');
  }

  notify('パイプライン完了');

  return {
    date,
    marketRow,
    voteResults,
    finalDecision,
    order,
    article,
  };
}

module.exports = { run };
