'use strict';

/**
 * financeArticleInject.test.js — 日刊記事への財前ミナ登場 Phase C
 *   - injectFinanceSection: 機械ブロック差し替え／非表示日の除去／新規挿入／ラベル行除去
 *   - articleValidator Rule 42: 表示整合・機械行の有無・提案の銘柄/金額一致
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const { injectFinanceSection, buildFinanceMachineLines } = require('../agents/publisher');
const { validateArticle } = require('../lib/articleValidator');
const financeStrategy = require('../config/financeStrategy');

const ARTICLE_SKELETON =
  '# 📊 AI Capital市場会議\n\n' +
  '## 🏢 各部署の判断\n### 審査部（鬼塚ガイ）\n判断：様子見支持\n要約：神谷の主張は成立。黒崎のリスク指摘は妥当。アオイの金額案は成立。\n\n' +
  '## 🔴 本日の論点\n・現金比率の低下をどう受け止めるか\n\n' +
  '## ⚖️ 最終判断\nシグナル：監視継続\n\n' +
  '*AI Capitalは投資助言サービスではありません。*\n';

// ── C1: injectFinanceSection ────────────────────────────────
test('C1.1 show=false・セクションなし → 変化なし', () => {
  const out = injectFinanceSection(ARTICLE_SKELETON, { show: false }, financeStrategy);
  assert.equal(out, ARTICLE_SKELETON);
});

test('C1.2 show=false・LLMが誤って💴セクション生成 → 丸ごと除去', () => {
  const withHallucination = ARTICLE_SKELETON.replace(
    '## 🔴 本日の論点',
    '## 💴 財務戦略部（財前ミナ）\n状態：監視中\n現金比率：30%\n余力は十分です。\n\n## 🔴 本日の論点',
  );
  const out = injectFinanceSection(withHallucination, { show: false }, financeStrategy);
  assert.doesNotMatch(out, /💴 財務戦略部/);
  assert.match(out, /## 🔴 本日の論点/);
});

test('C1.3 show=true monitoring・LLMがセクションを書いた → 機械行を差し替え・コメント保持・ラベル行除去', () => {
  const llm = ARTICLE_SKELETON.replace(
    '## 🔴 本日の論点',
    '## 💴 財務戦略部（財前ミナ）\n状態：発動中\n現金比率：99%（間違い）\n提案：オルカンを¥999,999利確\n現金比率は発動ラインに近づいています。無理には動きません。\n\n## 🔴 本日の論点',
  );
  const row = { mode: 'monitoring', status: 'monitoring', cash_ratio_before: '16.8' };
  const out = injectFinanceSection(llm, { show: true, tone: 'monitoring', row }, financeStrategy);
  assert.match(out, /## 💴 財務戦略部（財前ミナ）/);
  assert.match(out, /状態：監視中/);
  assert.match(out, /現金比率：16\.8%（発動ライン20%）/);
  assert.doesNotMatch(out, /99%（間違い）/);              // LLMの誤ラベル行は消える
  assert.doesNotMatch(out, /¥999,999/);                    // LLMの誤提案行も消える
  assert.match(out, /無理には動きません。/);               // コメント本文は残る
  assert.match(out, /## 🔴 本日の論点/);                   // 後続セクションは保持
});

test('C1.4 show=true monitoring・LLMがセクションを書かなかった → 🔴本日の論点の前に新規挿入', () => {
  const row = { mode: 'monitoring', status: 'monitoring', cash_ratio_before: '18.0' };
  const out = injectFinanceSection(ARTICLE_SKELETON, { show: true, tone: 'monitoring', row }, financeStrategy);
  const iMinae = out.indexOf('💴 財務戦略部');
  const iRonten = out.indexOf('🔴 本日の論点');
  const iGai = out.indexOf('審査部（鬼塚ガイ）');
  assert.ok(iGai < iMinae && iMinae < iRonten, `順序不正 gai=${iGai} minae=${iMinae} ronten=${iRonten}`);
  assert.match(out, /状態：監視中/);
  assert.match(out, /現金比率：18%（発動ライン20%）/);   // '18.0' → '18' に正規化
});

test('C1.5 show=true proposal → 提案行・承認行に finance_proposals の値', () => {
  const row = {
    mode: 'active', status: 'approved', cash_ratio_before: '15.0',
    asset_name: 'SOX', amount: '30000', gain_pct: '18.2',
    risk_review: 'APPROVE', audit_review: 'APPROVE',
  };
  const out = injectFinanceSection(ARTICLE_SKELETON, { show: true, tone: 'proposal', row }, financeStrategy);
  assert.match(out, /提案：SOX を ¥30,000 部分利確／含み益\+18\.2%/);
  assert.match(out, /承認：リスク管理部 APPROVE ／ 審査部 APPROVE → 承認/);
});

test('C1.6 show=true・LLMが空セクション → フォールバックコメントで埋める', () => {
  const llm = ARTICLE_SKELETON.replace(
    '## 🔴 本日の論点',
    '## 💴 財務戦略部（財前ミナ）\n\n## 🔴 本日の論点',
  );
  const row = { mode: 'monitoring', status: 'monitoring', cash_ratio_before: '16.8' };
  const out = injectFinanceSection(llm, { show: true, tone: 'monitoring', row }, financeStrategy);
  assert.match(out, /現金余力の回復機会をうかがいます。/);
});

test('C1.7 buildFinanceMachineLines: active・提案なし', () => {
  const lines = buildFinanceMachineLines({ tone: 'active', row: { mode: 'active', status: 'no_action', cash_ratio_before: '16.8' } }, financeStrategy);
  assert.match(lines, /状態：発動中/);
  assert.match(lines, /提案：なし（発動ラインは割ったが/);
});

// ── C2: articleValidator Rule 42 ───────────────────────────
const BASE = { pf: null, candidates: [], decisions: [], recs: [], articleNum: 'AC-2026-0099', date: '2026-09-08' };

function sectioned(extra) {
  return ARTICLE_SKELETON.replace('## 🔴 本日の論点',
    `## 💴 財務戦略部（財前ミナ）\n${extra}\n\n## 🔴 本日の論点`);
}

const rule42 = warnings => warnings.filter(w => /Rule 42/.test(w));

test('C2.1 financeCtx=null → Rule 42 は一切出ない（後方互換）', () => {
  const { warnings } = validateArticle({ ...BASE, note: ARTICLE_SKELETON });
  assert.equal(rule42(warnings).length, 0);
});

test('C2.2 show=true・セクションあり・機械行あり → Rule 42 なし', () => {
  const note = sectioned('状態：監視中\n現金比率：16.8%（発動ライン20%）\n無理には動きません。');
  const { warnings } = validateArticle({ ...BASE, note, financeCtx: { show: true, tone: 'monitoring', row: {} } });
  assert.equal(rule42(warnings).length, 0, rule42(warnings).join(' / '));
});

test('C2.3 show=true・セクションなし → Rule 42 警告', () => {
  const { warnings } = validateArticle({ ...BASE, note: ARTICLE_SKELETON, financeCtx: { show: true, tone: 'monitoring', row: {} } });
  assert.ok(warnings.some(w => /財務戦略部セクションが表示対象日なのに/.test(w)));
});

test('C2.4 show=false・セクションあり → Rule 42 警告', () => {
  const note = sectioned('状態：監視中\n現金比率：30%\n余力あり。');
  const { warnings } = validateArticle({ ...BASE, note, financeCtx: { show: false } });
  assert.ok(warnings.some(w => /非表示日なのに記事内に残って/.test(w)));
});

test('C2.5 show=true・機械行が欠落 → Rule 42 警告', () => {
  const note = sectioned('現金比率について所感を述べます。');
  const { warnings } = validateArticle({ ...BASE, note, financeCtx: { show: true, tone: 'monitoring', row: {} } });
  assert.ok(warnings.some(w => /機械挿入行（状態／現金比率）が見当たりません/.test(w)));
});

test('C2.6 proposal・提案銘柄が不一致 → Rule 42 警告', () => {
  const note = sectioned('状態：発動中\n現金比率：15%（発動ライン20%）\n提案：オルカン を ¥30,000 部分利確\n所感。');
  const fc = { show: true, tone: 'proposal', row: { asset_name: 'SOX', amount: '30000' } };
  const { warnings } = validateArticle({ ...BASE, note, financeCtx: fc });
  assert.ok(warnings.some(w => /提案銘柄が finance_proposals と一致しません/.test(w)));
});

test('C2.7 proposal・提案額が不一致 → Rule 42 警告', () => {
  const note = sectioned('状態：発動中\n現金比率：15%（発動ライン20%）\n提案：SOX を ¥10,000 部分利確\n所感。');
  const fc = { show: true, tone: 'proposal', row: { asset_name: 'SOX', amount: '30000' } };
  const { warnings } = validateArticle({ ...BASE, note, financeCtx: fc });
  assert.ok(warnings.some(w => /提案額が finance_proposals と一致しません/.test(w)));
});

// ── C3: 2026-09-08 本番FAIL の回帰（💴未登録→autofix剥がし→重複・現金比率不一致）──
const autoFix = require('../lib/articleAutoFix');

test('C3.1 💴 が両方の ALLOWED_HEADING_EMOJI に登録されている（autofix が見出しから剥がさない）', () => {
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../lib/articleAutoFix.js'), 'utf8');
  assert.match(src, /ALLOWED_HEADING_EMOJI[\s\S]{0,200}💴/);
  const vsrc = require('fs').readFileSync(require('path').resolve(__dirname, '../lib/articleValidator.js'), 'utf8');
  assert.match(vsrc, /ALLOWED_HEADING_EMOJI[\s\S]{0,200}💴/);
});

test('C3.2 autoFixLayout は 💴 財務戦略部 見出しを剥がさない', () => {
  const note = '## 🏢 各部署の判断\n### 審査部（鬼塚ガイ）\n要約：x\n\n## 💴 財務戦略部（財前ミナ）\n状態：発動中\n現金比率：14.4%（発動ライン20%）\n提案：なし\n所感を述べます。\n\n## 🔴 本日の論点\n・x\n';
  const { note: fixed } = autoFix.autoFixLayout(note);
  assert.match(fixed, /💴[ \t]*財務戦略部（財前ミナ）/, '💴 が剥がされてはいけない');
});

test('C3.3 現金比率は portfolio_status を優先（finance_proposals.cash_ratio_before は使わない）', () => {
  // 本番: pf.cash_ratio=14.4（pending反映後）/ row.cash_ratio_before=16.7（発動判定時） → 記事は 14.4
  const lines = buildFinanceMachineLines(
    { tone: 'active', row: { mode: 'active', status: 'no_action', cash_ratio_before: '16.7' } },
    financeStrategy,
    { cash_ratio: '14.4' },
  );
  assert.match(lines, /現金比率：14\.4%（発動ライン20%）/);
  assert.doesNotMatch(lines, /16\.7/);
});

test('C3.4 pf 未指定なら cash_ratio_before にフォールバック', () => {
  const lines = buildFinanceMachineLines(
    { tone: 'active', row: { mode: 'active', status: 'no_action', cash_ratio_before: '16.7' } },
    financeStrategy,
  );
  assert.match(lines, /現金比率：16\.7%/);
});

test('C3.5 LLM が 💴 を落とした見出し → 💴付きに正規化・重複なし・LLMコメント保持', () => {
  const llm = ARTICLE_SKELETON.replace(
    '## 🔴 本日の論点',
    '財務戦略部（財前ミナ）\n状態：発動中\n現金比率：16.7%（発動ライン 20% / 監視解除 25%）\n提案：なし（発動ラインは割ったが、利益確定の条件を満たす銘柄がなかった）\n利益確定に適した銘柄がなく今回は動きません。\n\n## 🔴 本日の論点',
  );
  const fc = { show: true, tone: 'active', row: { mode: 'active', status: 'no_action', cash_ratio_before: '16.7' } };
  const out = injectFinanceSection(llm, fc, financeStrategy, { cash_ratio: '14.4' });
  assert.equal((out.match(/財務戦略部（財前ミナ）/g) || []).length, 1, '1セクションに正規化');
  assert.match(out, /## 💴 財務戦略部（財前ミナ）/, '💴付き見出しになる');
  assert.equal((out.match(/提案：なし（発動ライン/g) || []).length, 1, '機械行の重複なし');
  assert.match(out, /現金比率：14\.4%（発動ライン20%）/);
  assert.match(out, /今回は動きません/, 'LLMコメント保持');
});

test('C3.6 injectFinanceSection は冪等（2回通しても1セクション）', () => {
  const fc = { show: true, tone: 'active', row: { mode: 'active', status: 'no_action', cash_ratio_before: '16.7' } };
  const once  = injectFinanceSection(ARTICLE_SKELETON, fc, financeStrategy, { cash_ratio: '14.4' });
  const twice = injectFinanceSection(once, fc, financeStrategy, { cash_ratio: '14.4' });
  assert.equal((twice.match(/財務戦略部（財前ミナ）/g) || []).length, 1);
  assert.equal((twice.match(/提案：なし（発動ライン/g) || []).length, 1);
});

test('C3.7 既存💴セクション＋LLMが2個目を追記 → 1つに収束・幻覚値除去', () => {
  const fc = { show: true, tone: 'active', row: { mode: 'active', status: 'no_action', cash_ratio_before: '16.7' } };
  const one = injectFinanceSection(ARTICLE_SKELETON, fc, financeStrategy, { cash_ratio: '14.4' });
  const dup = one.replace('## 🔴 本日の論点', '財務戦略部（財前ミナ）\n状態：発動中\n現金比率：99%\n提案：なし（発動ラインは割ったが、利益確定の条件を満たす銘柄がなかった）\n重複本文。\n\n## 🔴 本日の論点');
  const out = injectFinanceSection(dup, fc, financeStrategy, { cash_ratio: '14.4' });
  assert.equal((out.match(/財務戦略部（財前ミナ）/g) || []).length, 1);
  assert.doesNotMatch(out, /99%/);
});

test('C3.8 Rule 42 は 💴 を落とした見出しでもセクションを検出できる', () => {
  const note = ARTICLE_SKELETON.replace('## 🔴 本日の論点',
    '財務戦略部（財前ミナ）\n状態：発動中\n現金比率：14.4%（発動ライン20%）\n提案：なし\n所感。\n\n## 🔴 本日の論点');
  const { warnings } = validateArticle({ ...BASE, note, financeCtx: { show: true, tone: 'active', row: {} } });
  assert.equal(warnings.filter(w => /Rule 42/.test(w)).length, 0, warnings.filter(w => /Rule 42/.test(w)).join(' / '));
});
