'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const finance       = require('../agents/finance');
const financeReview = require('../agents/finance-review');

// ── 呼び出しを記録するモック sheets ───────────────────────────
function makeSheets({ pf = null, orders = [], proposals = [] } = {}) {
  const calls = { upsert: [], append: [] };
  return {
    calls,
    getLatestRowAsOf: async (name) => (name === 'portfolio_status' ? pf : null),
    getRows: async (name) => {
      if (name === 'orders') return orders;
      if (name === 'finance_proposals') return proposals;
      return [];
    },
    getRowsByDate: async () => [],
    upsertRow: async (name, keys, row) => { calls.upsert.push({ name, keys, row }); return {}; },
    appendRow: async (name, row) => { calls.append.push({ name, row }); return {}; },
  };
}

const pos = (name, cost, mv) => ({ name, cost_basis: cost, market_value: mv, unrealized_pl: mv - cost });
const PF_MONITOR = {
  total_assets: '11500000', cash: '3450000', invested: '8050000', cash_ratio: '30',
  positions_json: JSON.stringify([pos('SOX', 2000000, 2400000)]),
};
const PF_ACTIVE = {
  total_assets: '11500000', cash: '2070000', invested: '9430000', cash_ratio: '18',
  positions_json: JSON.stringify([pos('SOX', 2000000, 2400000)]),
};
const SOX_OLD_ORDERS = [
  { status: 'filled', asset_name: 'SOX', date: '2026-06-01', amount: '1200000' },
  { status: 'filled', asset_name: 'SOX', date: '2026-07-15', amount: '800000' },
];

// ── Step 2c: finance.analyze の配線挙動 ──────────────────────

test('1b: 公開前（2026-08-30）は inactive → null・finance_proposals へ一切書かない', async () => {
  const sheets = makeSheets({ pf: PF_MONITOR });
  const r = await finance.analyze('2026-08-30', { sheets });
  assert.equal(r, null);
  assert.equal(sheets.calls.upsert.length, 0);
  assert.equal(sheets.calls.append.length, 0);
});

test('1b: 公開初日・現金比率30% → monitoring 行のみ。提案・注文・agent_votes 書き込みなし', async () => {
  const sheets = makeSheets({ pf: PF_MONITOR, proposals: [] });
  const r = await finance.analyze('2026-08-31', { sheets });

  assert.equal(r.mode, 'monitoring');
  assert.equal(r.signal, 'HOLD');
  assert.equal(r.monitoring, true);
  assert.equal(r.proposal, undefined, 'monitoring では proposal を持たない（Step 2d が呼ばれない）');

  // finance_proposals へ monitoring 行が 1 回だけ
  const fp = sheets.calls.upsert.filter(c => c.name === 'finance_proposals');
  assert.equal(fp.length, 1);
  assert.equal(fp[0].row.mode, 'monitoring');
  assert.equal(fp[0].row.status, 'monitoring');
  assert.equal(fp[0].row.amount, '');

  // 他シートへは一切書かない
  const other = [...sheets.calls.upsert, ...sheets.calls.append].filter(c => c.name !== 'finance_proposals');
  assert.deepEqual(other, [], 'finance_proposals 以外への書き込みはゼロ（agent_votes / orders / final_decisions 等）');
});

test('1b: active でもゲート不通過なら no_action（提案なし・注文なし）', async () => {
  const sheets = makeSheets({
    pf: { ...PF_ACTIVE, positions_json: JSON.stringify([pos('SOX', 2000000, 2100000)]) }, // 含み益 +5% < 15%
    orders: SOX_OLD_ORDERS,
    proposals: [{ date: '2026-08-31', mode: 'monitoring', status: 'monitoring', cash_ratio_before: '18' }],
  });
  const r = await finance.analyze('2026-09-01', { sheets });
  assert.equal(r.mode, 'active');
  assert.equal(r.proposal.status, 'no_action');
  assert.equal(r.signal, 'HOLD');
  const fp = sheets.calls.upsert.filter(c => c.name === 'finance_proposals');
  assert.equal(fp[0].row.status, 'no_action');
  assert.equal(sheets.calls.append.length, 0, 'orders への append はゼロ');
});

test('1b: active かつゲート通過なら status=proposed（承認ゲートが呼ばれる条件）', async () => {
  const sheets = makeSheets({
    pf: PF_ACTIVE,
    orders: SOX_OLD_ORDERS,
    proposals: [{ date: '2026-08-31', mode: 'monitoring', status: 'monitoring', cash_ratio_before: '18' }],
  });
  const r = await finance.analyze('2026-09-01', { sheets });
  assert.equal(r.mode, 'active');
  assert.equal(r.proposal.status, 'proposed');
  assert.equal(r.signal, 'REDUCE');
  assert.ok(Number(r.proposal.amount) > 0);
  // それでも orders / agent_votes には書かない（実行は Step 4・増分 1e）
  assert.equal(sheets.calls.append.length, 0);
  const nonFp = sheets.calls.upsert.filter(c => c.name !== 'finance_proposals');
  assert.deepEqual(nonFp, []);
});

test('1b: 同日に終端ステータス（approved/executed/rejected）の行があれば再評価しない（冪等）', async () => {
  const sheets = makeSheets({
    pf: PF_ACTIVE, orders: SOX_OLD_ORDERS,
    proposals: [{ date: '2026-09-01', mode: 'active', status: 'rejected', cash_ratio_before: '18' }],
  });
  const r = await finance.analyze('2026-09-01', { sheets });
  assert.equal(r.signal, 'HOLD');
  assert.ok(r.existing, '既存の終端行を返す');
  assert.equal(sheets.calls.upsert.length, 0, '再 upsert しない');
});

test('1b: analyze はどの分岐でも agent_votes / orders へ書き込まない', async () => {
  for (const [date, pf, proposals] of [
    ['2026-08-30', PF_MONITOR, []],
    ['2026-08-31', PF_MONITOR, []],
    ['2026-09-01', PF_ACTIVE, [{ date: '2026-08-31', status: 'monitoring', cash_ratio_before: '18' }]],
  ]) {
    const sheets = makeSheets({ pf, orders: SOX_OLD_ORDERS, proposals });
    await finance.analyze(date, { sheets });
    const banned = [...sheets.calls.upsert, ...sheets.calls.append]
      .filter(c => ['agent_votes', 'agent_recommendations', 'orders', 'final_decisions'].includes(c.name));
    assert.deepEqual(banned, [], `${date}: 禁止シートへの書き込みなし`);
  }
});

// ── Step 2d: applyReview（承認結果の永続化） ─────────────────

test('1b: applyReview は approved を反映する', async () => {
  const sheets = makeSheets();
  const base = { date: '2026-09-01', mode: 'active', status: 'proposed', asset_name: 'SOX', amount: '200000' };
  const approval = { approved: true, risk: { verdict: 'APPROVE', reason: 'ok' }, audit: { verdict: 'APPROVE', reason: 'ok' } };
  const out = await financeReview.applyReview('2026-09-01', base, approval, { sheets });
  assert.equal(out.status, 'approved');
  assert.equal(sheets.calls.upsert[0].row.status, 'approved');
  assert.match(sheets.calls.upsert[0].row.risk_review, /APPROVE/);
});

test('1b: applyReview は fail-closed（approved!==true は全て rejected）', async () => {
  const sheets = makeSheets();
  const base = { date: '2026-09-01', status: 'proposed', asset_name: 'SOX', amount: '200000' };
  for (const approval of [
    { approved: false, risk: { verdict: 'REJECT', reason: '過大' }, audit: { verdict: 'APPROVE', reason: 'ok' } },
    { approved: false, failClosed: true, risk: { verdict: 'REJECT', reason: 'timeout' }, audit: { verdict: 'REJECT', reason: 'timeout' } },
    null,
  ]) {
    const out = await financeReview.applyReview('2026-09-01', base, approval, { sheets });
    assert.equal(out.status, 'rejected');
  }
});

// ── secretary.js のソース構造アサーション（既存経路を壊していないことの確認）──

const secretarySrc = fs.readFileSync(path.resolve(__dirname, '../secretary.js'), 'utf8');
// コメント行・行末コメントを除いた「実コード」（構造アサーションが説明コメントに反応しないように）
const secretaryCode = secretarySrc
  .split('\n')
  .map(l => l.replace(/\/\/.*$/, ''))
  .filter(l => !/^\s*\*/.test(l) && !/^\s*\/\*/.test(l))
  .join('\n');

test('1b: secretary.js は Step 2c で finance.analyze(date) を呼ぶ', () => {
  assert.match(secretarySrc, /finance\.analyze\(date\)/);
});

test('1b: Step 2d の承認ゲートは status === "proposed" のときだけ実行される', () => {
  assert.match(secretarySrc, /financeResult\.proposal\.status === 'proposed'/);
});

test('1b: finance.analyze は try/catch で囲まれ、失敗してもパイプラインを止めない（financeResult=null）', () => {
  assert.match(secretarySrc, /try\s*\{[\s\S]*?finance\.analyze\(date\)[\s\S]*?\}\s*catch[\s\S]*?financeResult = null/);
});

test('1b: Step 4 の買い注文フローは従来どおり（processSignal・finance で分岐しない）', () => {
  assert.match(secretaryCode, /orderManager\.processSignal\(finalDecision\)/);
  // 買い注文が finance の状態で条件分岐していないこと
  assert.doesNotMatch(secretaryCode, /if\s*\([^)]*finance[^)]*\)[\s\S]{0,80}processSignal/);
});

test('1b: 集約は n=4 のまま（successCount / "/4" 表記が残っている）', () => {
  assert.match(secretaryCode, /\/4 エージェント投票成功/);
});

test('1b: secretary.js はまだ売却を実行しない（processSellSignal を呼ばない・増分 1e）', () => {
  assert.doesNotMatch(secretaryCode, /processSellSignal\s*\(/);
});

test('1b: secretary.js の実コードに agent_votes 直接操作はない（従来どおり各 agent に委譲）', () => {
  assert.doesNotMatch(secretaryCode, /agent_votes/);
});

// ── publisher.js の財務戦略部結合（記事登場 Phase A 以降）──
// 旧「1b では未結合」ガードは記事デビュー実装で撤廃。Phase A で publisher が
// finance_proposals を読み、resolveArticleVisibility で登場可否を判定する。

const publisherSrc = fs.readFileSync(path.resolve(__dirname, '../agents/publisher.js'), 'utf8');

test('記事Phase A: publisher.js は finance_proposals を読み、記事登場ゲートを評価する', () => {
  assert.match(publisherSrc, /finance_proposals/);
  assert.match(publisherSrc, /resolveArticleVisibility/);
});

// 記事 Phase C: articleValidator.js は財務戦略部セクションの整合性（Rule 42）を持つ。
const validatorSrc = fs.readFileSync(path.resolve(__dirname, '../lib/articleValidator.js'), 'utf8');
test('記事Phase C: articleValidator.js は財務戦略部セクションを Rule 42 で検証する', () => {
  assert.match(validatorSrc, /財務戦略部/);
  assert.match(validatorSrc, /warn\(42/);
  assert.match(validatorSrc, /financeCtx/);
});
