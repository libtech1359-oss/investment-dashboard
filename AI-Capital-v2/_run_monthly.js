'use strict';
/**
 * _run_monthly.js — 月刊レポートデバッグ用手動確認スクリプト
 *
 * 使い方:
 *   node _run_monthly.js 2026-06-01 2026-06-30
 *
 * 引数省略時は当月（1日〜末日）を自動判定。
 *
 * NOTE: 現時点はコンソール出力のみ。note保存・公開は行わない。
 */
require('dotenv').config();

const { buildMonthlyDraft } = require('./agents/monthly');

function currentMonthRange() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth();
  const start = new Date(year, month, 1);
  const end   = new Date(year, month + 1, 0);
  const fmt   = d => d.toISOString().slice(0, 10);
  return [fmt(start), fmt(end)];
}

async function main() {
  let [,, start, end] = process.argv;

  if (!start || !end) {
    [start, end] = currentMonthRange();
    console.log(`引数なし → 当月を自動設定: ${start} 〜 ${end}\n`);
  }

  console.log(`月刊ドラフト生成: ${start} 〜 ${end}\n`);

  const { note, meta } = await buildMonthlyDraft(start, end);

  console.log('--- メタデータ ---');
  console.log(JSON.stringify(meta, null, 2));
  console.log('');
  console.log('='.repeat(60));
  console.log(note);
  console.log('='.repeat(60));
  console.log(`\n✅ 月刊ドラフト確認完了 ${meta.month_id}（${note.length}文字）`);
  console.log('※ 保存・公開は行っていません。');
}

main().catch(e => {
  console.error('エラー:', e.message);
  process.exit(1);
});
