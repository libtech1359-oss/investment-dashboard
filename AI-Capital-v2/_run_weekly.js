'use strict';
/**
 * _run_weekly.js — 週刊記事デバッグ用手動実行スクリプト
 *
 * 使い方:
 *   node _run_weekly.js 2026-06-23 2026-06-28
 *
 * 引数省略時は当週（月〜金）を自動判定。
 *
 * NOTE: 現時点はコンソール出力のみ。note保存・公開は行わない。
 */
require('dotenv').config();

const { buildWeeklyDraft, gatherWeeklyData } = require('./agents/weekly');

function currentWeekRange() {
  const today = new Date();
  const dow   = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const fmt = d => d.toISOString().slice(0, 10);
  return [fmt(monday), fmt(friday)];
}

async function main() {
  let [,, start, end] = process.argv;

  if (!start || !end) {
    [start, end] = currentWeekRange();
    console.log(`引数なし → 当週を自動設定: ${start} 〜 ${end}\n`);
  }

  console.log(`週刊データ収集: ${start} 〜 ${end}\n`);

  // データ構造の確認
  const data = await gatherWeeklyData(start, end);
  console.log('--- 集計サマリー ---');
  console.log(`営業日数: ${data.period.days}`);
  console.log(`市場データ: ${data.market.length}行`);
  console.log(`部署投票: ${Object.values(data.votesByDept).flatMap(Object.values).reduce((a, b) => a + b, 0)}件`);
  console.log(`発注: ${data.orders.length}件`);
  console.log(`ポートフォリオ: ${data.portfolio ? '取得済み' : 'なし'}`);
  console.log(`ポジション: ${data.positions.length}件`);
  console.log('');

  // ドラフト生成
  const { note, meta } = await buildWeeklyDraft(start, end);

  console.log('--- メタデータ ---');
  console.log(JSON.stringify(meta, null, 2));
  console.log('');
  console.log('='.repeat(60));
  console.log(note);
  console.log('='.repeat(60));
  console.log(`\n✅ 週刊ドラフト生成完了 ${meta.week_id}（${note.length}文字）`);
  console.log('※ 保存・公開は行っていません。');
}

main().catch(e => {
  console.error('エラー:', e.message);
  process.exit(1);
});
