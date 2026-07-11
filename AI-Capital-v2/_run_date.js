'use strict';
require('dotenv').config();

const dataFetcher      = require('./lib/dataFetcher');
const signalAggregator = require('./lib/signalAggregator');
const orderManager     = require('./lib/orderManager');
const market           = require('./agents/market');
const portfolio        = require('./agents/portfolio');
const risk             = require('./agents/risk');
const audit            = require('./agents/audit');
const publisher        = require('./agents/publisher');

// 実行日付を固定（引数があれば優先）
const date = process.argv[2] || '2026-06-26';

function log(msg) { console.log(`[run_date:${date}] ${msg}`); }

(async () => {
  log(`パイプライン開始`);

  // Step 1: 市場データ取得（既存データがあればスキップ）
  log('Step 1/5 データ取得・市場データ書き込み...');
  try {
    await dataFetcher.run();
    log('Step 1 完了');
  } catch (e) {
    log(`Step 1 失敗（続行）: ${e.message}`);
  }

  // Step 2a: マーケット/ポートフォリオ/リスク（並列）
  log('Step 2/5 各部署分析・投票...');
  const [mktResult, pfResult, riskResult] = await Promise.allSettled([
    market.analyze(date),
    portfolio.analyze(date),
    risk.analyze(date),
  ]);
  if (mktResult.status  === 'rejected') log(`マーケット部エラー: ${mktResult.reason?.message}`);
  if (pfResult.status   === 'rejected') log(`ポートフォリオ部エラー: ${pfResult.reason?.message}`);
  if (riskResult.status === 'rejected') log(`リスク管理部エラー: ${riskResult.reason?.message}`);

  // Step 2b: 審査部（他部署の投票を読んでから実行）
  const auditResult = await Promise.allSettled([audit.analyze(date)]).then(r => r[0]);
  if (auditResult.status === 'rejected') log(`審査部エラー: ${auditResult.reason?.message}`);

  const successCount = [mktResult, pfResult, riskResult, auditResult].filter(r => r.status === 'fulfilled').length;
  log(`Step 2 完了: ${successCount}/4 エージェント投票成功`);

  // Step 3: シグナル集約
  log('Step 3/5 シグナル集約（機械判定）...');
  let finalDecision;
  try {
    finalDecision = await signalAggregator.run(date);
    log(`Step 3 完了: ${finalDecision.final_signal} → ${finalDecision.target_asset || 'なし'} ¥${finalDecision.amount || 0}`);
  } catch (e) {
    log(`Step 3 失敗: ${e.message}`);
    finalDecision = null;
  }

  // Step 3.5: article_decisions 保存
  try {
    await dataFetcher.writeArticleDecision(date, finalDecision);
  } catch (e) {
    log(`article_decisions 保存失敗（続行）: ${e.message}`);
  }

  // Step 4: 発注記録
  log('Step 4/5 発注記録...');
  let order = null;
  try {
    order = await orderManager.processSignal(finalDecision);
    if (order) log(`Step 4 完了: 注文ID ${order.order_id} ${order.asset_name} ¥${parseInt(order.amount).toLocaleString()}`);
    else        log('Step 4: 発注不要');
  } catch (e) {
    log(`Step 4 失敗: ${e.message}`);
  }

  // Step 5: 記事生成
  log('Step 5/5 記事生成...');
  try {
    const result = await publisher.publish(date);
    log(`Step 5 完了: ${result.noteUrl || '（URL未取得）'}`);
    console.log('\n=== 完了 ===');
    console.log('note URL:', result.noteUrl || '（未取得）');
  } catch (e) {
    log(`Step 5 失敗: ${e.message}`);
    console.error(e.stack);
  }

  process.exit(0);
})();
