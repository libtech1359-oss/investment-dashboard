'use strict';

/**
 * _setup_gas.js — asset_master セットアップ + 新GAS切り替え支援
 *
 * 使い方:
 *   node _setup_gas.js              — asset_master に9銘柄を投入（シートが存在する場合）
 *   node _setup_gas.js --force      — 全消去して再投入
 *   node _setup_gas.js --check      — シート存在確認のみ
 *   node _setup_gas.js --switch-gas — 新GASに切り替え（要: ブラウザ認可済み後）
 *
 * 新GAS URLは .gas-new-url.txt に保存済み。
 * ブラウザ認可方法は --switch-gas 実行時に案内します。
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const SPREADSHEET_ID = '1NEv0c9wPSJbHnlJFRHD0Su-gGPnZYNxQWRBpXWF1rOA';
const FORCE      = process.argv.includes('--force');
const CHECK_ONLY = process.argv.includes('--check');
const SWITCH_GAS = process.argv.includes('--switch-gas');
const ENV_FILE   = path.join(__dirname, '.env');
const NEW_URL_FILE = path.join(__dirname, '.gas-new-url.txt');

const ASSETS = [
  { id:'allcountry', short_name:'オルカン',   full_name:'eMAXIS Slim 全世界株式（オール・カントリー）',       proxy_symbol:'ACWI',    category:'core',    enabled:'TRUE', nav_code:'0331418A' },
  { id:'sp500',      short_name:'S&P500',    full_name:'eMAXIS Slim 米国株式（S&P500）',                  proxy_symbol:'^GSPC',   category:'core',    enabled:'TRUE', nav_code:'03311187' },
  { id:'nasdaq100',  short_name:'NASDAQ100', full_name:'ニッセイNASDAQ100インデックスファンド',               proxy_symbol:'^NDX',    category:'core',    enabled:'TRUE', nav_code:'29313233' },
  { id:'nikkei225',  short_name:'日経平均',   full_name:'eMAXIS Slim 国内株式（日経平均）',                  proxy_symbol:'^N225',   category:'core',    enabled:'TRUE', nav_code:'03311182' },
  { id:'fang',       short_name:'FANG+',    full_name:'iFreeNEXT FANG+インデックス',                      proxy_symbol:'^NYFANG', category:'growth',  enabled:'TRUE', nav_code:'04311181' },
  { id:'sox',        short_name:'SOX',      full_name:'iFreeNEXT 全世界半導体株インデックス',               proxy_symbol:'^SOX',    category:'growth',  enabled:'TRUE', nav_code:'04312257' },
  { id:'ztech20',    short_name:'Zテック20',  full_name:'iFreePlus 世界トレンド・テクノロジー株（Zテック20）', proxy_symbol:'',        category:'theme',   enabled:'TRUE', nav_code:'0431124C' },
  { id:'gold',       short_name:'ゴールド',   full_name:'SBI・iシェアーズ・ゴールドファンド',                 proxy_symbol:'GC=F',    category:'defense', enabled:'TRUE', nav_code:'8931A236' },
];

async function gasGet(gasUrl, sheet) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${gasUrl}?sheet=${encodeURIComponent(sheet)}`, { signal: ctrl.signal });
    clearTimeout(tid);
    const text = await res.text();
    if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) return { _html: true };
    const json = JSON.parse(text);
    return json;
  } catch (err) {
    clearTimeout(tid);
    return { _error: err.message };
  }
}

async function gasPost(gasUrl, body) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(gasUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
    });
    clearTimeout(tid);
    const text = await res.text();
    if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) return { _html: true };
    try { return JSON.parse(text); } catch { return { error: 'JSON解析失敗' }; }
  } catch (err) {
    clearTimeout(tid);
    return { _error: err.message };
  }
}

function banner(title) {
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(55));
}

// ── 新GASへの切り替え ──────────────────────────────────────
async function switchToNewGas() {
  banner('新GASへの切り替え確認');

  if (!fs.existsSync(NEW_URL_FILE)) {
    console.log('  ❌ .gas-new-url.txt が見つかりません');
    return;
  }

  const newUrl = fs.readFileSync(NEW_URL_FILE, 'utf8').trim();
  console.log(`  新GAS URL: ${newUrl.slice(0, 70)}...`);

  // 新GASが動作するか確認
  const testRes = await gasGet(newUrl, 'market_data');

  if (testRes._html) {
    console.log('  ❌ 新GASが認可されていません。以下の手順で認可してください:');
    console.log('');
    console.log('  【手順】');
    console.log('  1. ブラウザで以下のURLを開く:');
    console.log(`     ${newUrl}`);
    console.log('  2. Google アカウントでログインして「許可」をクリック');
    console.log('  3. このスクリプトを再実行:');
    console.log('     node _setup_gas.js --switch-gas');
    return;
  }

  if (testRes.error || testRes._error) {
    // 既存データが読めない可能性があるが、動作はしている
    console.log(`  ⚠️  GASは応答しましたが: ${JSON.stringify(testRes).slice(0, 100)}`);
  } else if (Array.isArray(testRes)) {
    console.log(`  ✅ 新GAS 動作確認OK (market_data: ${testRes.length}行)`);
  }

  // .env を更新
  let env = fs.readFileSync(ENV_FILE, 'utf8');
  env = env.replace(/^GAS_V2_URL=.*/m, `GAS_V2_URL=${newUrl}`);
  fs.writeFileSync(ENV_FILE, env);
  console.log(`  ✅ .env を新GAS URLに更新しました`);

  // .gas-new-url.txt を削除
  fs.unlinkSync(NEW_URL_FILE);
  console.log('  ✅ .gas-new-url.txt を削除しました');

  console.log('\n  切り替え完了。node _setup_gas.js --force で9銘柄を投入してください。');
}

// ── メイン ────────────────────────────────────────────────
async function main() {
  const gasUrl = process.env.GAS_V2_URL;
  if (!gasUrl) throw new Error('.env に GAS_V2_URL が設定されていません');

  if (SWITCH_GAS) {
    await switchToNewGas();
    return;
  }

  console.log('🚀 AI Capital v2 — asset_master セットアップ');
  console.log(`GAS URL: ${gasUrl.slice(0, 60)}...`);
  if (FORCE) console.log('⚠️  --force: 全消去して再投入');

  // ── シート存在確認 ──────────────────────────────────────
  banner('シート状態確認');

  const sheets = ['market_data', 'asset_master', 'candidate_assets', 'portfolio_status', 'orders', 'positions', 'agent_votes', 'final_decisions'];
  const status = {};

  await Promise.all(sheets.map(async s => {
    const res = await gasGet(gasUrl, s);
    if (res._html)    status[s] = { exists: false, reason: 'GAS HTML応答（要認可）' };
    else if (res.error === `sheet not found: ${s}`) status[s] = { exists: false, reason: 'シート未作成' };
    else if (res._error) status[s] = { exists: false, reason: res._error };
    else                 status[s] = { exists: true,  rows: Array.isArray(res) ? res.length : 0 };
  }));

  sheets.forEach(s => {
    const st = status[s];
    if (st.exists) console.log(`  ✅ ${s.padEnd(20)} (${st.rows}行)`);
    else           console.log(`  ❌ ${s.padEnd(20)} — ${st.reason}`);
  });

  if (CHECK_ONLY) return;

  // asset_master が存在しない場合は setup_sheets を自動実行
  if (!status['asset_master'].exists) {
    banner('setup_sheets を実行中...');
    const setupRes = await gasPost(gasUrl, { action: 'setup_sheets' });
    if (setupRes._html) {
      console.log('  ❌ GASが認可されていません。ブラウザで以下URLを開いて「許可」してください:');
      console.log(`     ${gasUrl}`);
      return;
    }
    if (setupRes.ok && setupRes.setup_sheets) {
      setupRes.setup_sheets.forEach(r => console.log(`  ${r.status === 'created' ? '✅ 作成' : '🔄 既存'} ${r.sheet}`));
    } else {
      console.log('  ⚠️  setup_sheets 応答:', JSON.stringify(setupRes).slice(0, 200));
    }
  }

  // ── asset_master に9銘柄を投入 ──────────────────────────
  banner('asset_master 標準9銘柄を投入');

  const existing = await gasGet(gasUrl, 'asset_master');
  const existingRows = Array.isArray(existing) ? existing : [];

  if (existingRows.length > 0 && !FORCE) {
    console.log(`  ⏭️  スキップ: 既存 ${existingRows.length} 行 (--force で再投入)`);
    existingRows.forEach(a => {
      const proxy = a.proxy_symbol || '(なし)';
      console.log(`     ${(a.id || '?').padEnd(12)} ${(a.short_name || '?').padEnd(10)} proxy=${proxy}`);
    });
    return;
  }

  let insertCount = 0;
  for (const a of ASSETS) {
    const res = await gasPost(gasUrl, { sheet: 'asset_master', action: 'upsert', keys: ['id'], data: a });
    if (res._html) {
      console.log('  ❌ GAS が HTML を返しました。認可が必要です。');
      break;
    }
    const action = res.ok ? (res.action === 'updated' ? '更新' : '追加') : ('ERROR: ' + JSON.stringify(res).slice(0,50));
    console.log(`  ${a.id.padEnd(12)} ${a.short_name.padEnd(10)} proxy=${(a.proxy_symbol||'なし').padEnd(8)} → ${action}`);
    if (res.ok) insertCount++;
  }

  if (insertCount > 0) {
    console.log(`\n  ✅ ${insertCount}/${ASSETS.length} 銘柄を投入しました`);
  }

  // ── 完了 ─────────────────────────────────────────────
  banner('完了');
  console.log('');
  console.log('次のステップ:');
  console.log('  node _run_daily.js   — パイプライン1回実行');
  console.log('  node _diag.js        — 診断');
  console.log('');
  console.log(`📊 スプレッドシート: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
  console.log('');
}

main().catch(err => {
  console.error('\n❌ エラー:', err.message);
  process.exit(1);
});
