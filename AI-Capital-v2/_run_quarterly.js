'use strict';
/**
 * _run_quarterly.js — 四半期レポートデバッグ用手動確認スクリプト
 *
 * 使い方:
 *   node _run_quarterly.js 2026-04-01 2026-06-30
 *
 * 引数省略時は当四半期（初日〜末日）を自動判定。
 *
 * NOTE: 現時点はコンソール出力のみ。note保存・公開は行わない。
 */
require('dotenv').config();

const { buildQuarterlyDraft } = require('./agents/quarterly');

function currentQuarterRange() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const q     = Math.floor(month / 3);
  const start = new Date(year, q * 3, 1);
  const end   = new Date(year, q * 3 + 3, 0);
  const fmt   = d => d.toISOString().slice(0, 10);
  return [fmt(start), fmt(end)];
}

async function main() {
  let [,, start, end] = process.argv;

  if (!start || !end) {
    [start, end] = currentQuarterRange();
    console.log(`引数なし → 当四半期を自動設定: ${start} 〜 ${end}\n`);
  }

  console.log(`四半期ドラフト生成: ${start} 〜 ${end}\n`);

  const { note, meta } = await buildQuarterlyDraft(start, end);

  console.log('--- メタデータ ---');
  console.log(JSON.stringify(meta, null, 2));
  console.log('');
  console.log('='.repeat(60));
  console.log(note);
  console.log('='.repeat(60));
  console.log(`\n✅ 四半期ドラフト確認完了 ${meta.quarter_id}（${note.length}文字）`);
  console.log('※ 保存・公開は行っていません。');
}

main().catch(e => {
  console.error('エラー:', e.message);
  process.exit(1);
});
