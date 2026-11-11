'use strict';

/**
 * 自由文判定ルール（Rule 11/12/20/22/24/25/39/43）の誤検出回帰テスト。
 * 2026-11-05 の棚卸しで、否定・疑問・他者意見の紹介を「その主張をする文」と誤認する型の弱点を
 * 共通ヘルパー（findAssertion）で除去した。各ルールについて
 *   - 誤検出してはいけない文（negative）
 *   - 本当の矛盾は引き続き検出する文（positive）
 * の両方を固定する（検出力が落ちていないことの証明）。
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { validateArticle } = require('../lib/articleValidator');

const has = (res, n) => res.warnings.some(w => new RegExp(`Rule ${String(n).padStart(2, '0')}\\b`).test(w));
const run = args => validateArticle({ pf: null, candidates: [], decisions: [], recs: [], articleNum: 'AC-T-1', date: '2026-11-05', ...args });

const rec = (department, type, asset = 'なし') => ({ department, recommendation_type: type, asset_name: asset });
const cand = (asset_name, extra = {}) => ({ asset_name, full_name: asset_name, ...extra });
const buyDecision = [{ final_signal: 'ACCUMULATE', target_asset: 'SOX', amount: 10000 }];
const waitDecision = [{ final_signal: 'WAIT', target_asset: 'なし', amount: 0 }];

// ── Rule 12 ──────────────────────────────────────────────
const recsAllWait = [rec('マーケット分析部', 'WAIT'), rec('リスク管理部', 'WAIT')];
test('Rule12: 「意見が割れることなく」等の否定は全員一致の日に検出しない', () => {
  const note = '📌 今日の見どころ\n\n部署間で意見が割れることなく、見送りで固まりました。対立はありませんでした。\n';
  assert.ok(!has(run({ note, recs: recsAllWait }), 12));
});
test('Rule12: 全員一致の日に「意見が割れた」と書けば検出する', () => {
  const note = '📌 今日の見どころ\n\n部署間で意見が割れました。\n';
  assert.ok(has(run({ note, recs: recsAllWait }), 12));
});

// ── Rule 11 (B-1 / B-2) ──────────────────────────────────
const candsSoxNas = [cand('SOX', { rank: 1 }), cand('NASDAQ100', { rank: 2 })];
test('Rule11 B-1: 「NASDAQ100を採用するかが論点」は検出しない', () => {
  const note = '🔴 本日の論点\n・NASDAQ100を採用するかが論点です。\n\n⚖️ 最終判断\n\nSOX\n';
  assert.ok(!has(run({ note, candidates: candsSoxNas, decisions: buyDecision }), 11));
});
test('Rule11 B-1: 実際と異なる銘柄を「採用しました」と書けば検出する', () => {
  const note = '🔴 本日の論点\n・NASDAQ100を採用しました。\n\n⚖️ 最終判断\n\nSOX\n';
  assert.ok(has(run({ note, candidates: candsSoxNas, decisions: buyDecision }), 11));
});

// ── Rule 20（2026-11-05 実インシデント） ───────────────────
test('Rule20: 部署名での言及でも審査コメントとして認める', () => {
  const note = '🧐 審査部（鬼塚ガイ）\n判断：様子見支持\n要約：神谷の指摘は妥当で、黒崎の指摘も成立し、ポートフォリオ管理部の資金抑制の指摘も整合的です。\n推奨：\n今回は見送ります\n\n⚖️ 最終判断\n';
  const recs = [rec('マーケット分析部', 'WAIT'), rec('リスク管理部', 'WAIT'), rec('ポートフォリオ管理部', 'WAIT')];
  assert.ok(!has(run({ note, recs }), 20));
});
test('Rule20: ポートフォリオ側への言及が全く無ければ検出する', () => {
  const note = '🧐 審査部（鬼塚ガイ）\n判断：様子見支持\n要約：神谷の指摘は妥当で、黒崎の指摘も成立します。\n\n⚖️ 最終判断\n';
  const recs = [rec('マーケット分析部', 'WAIT'), rec('リスク管理部', 'WAIT'), rec('ポートフォリオ管理部', 'WAIT')];
  assert.ok(has(run({ note, recs }), 20));
});

// ── Rule 22 ──────────────────────────────────────────────
const misaki = body => `🤨 リスク管理部（黒崎ミサキ）\n判断：様子見\n要約：集中投資率は8.0%で、${body}\n\n⚖️ 最終判断\n`;
test('Rule22: 「極めて高水準とは言えません」は検出しない', () => {
  assert.ok(!has(run({ note: misaki('極めて高水準とは言えません。') }), 22));
});
test('Rule22: 低水準なのに「極めて高水準です」は検出する', () => {
  assert.ok(has(run({ note: misaki('極めて高水準です。') }), 22));
});

// ── Rule 24 ──────────────────────────────────────────────
test('Rule24: 「暴落とは言えない水準」は検出しない', () => {
  assert.ok(!has(run({ note: '⚠️ リスク\nVIX：17.2（普通）\n\nVIX 17.2 は暴落とは言えない水準です。\n' }), 24));
});
test('Rule24: VIX平穏なのに「暴落しています」は検出する', () => {
  assert.ok(has(run({ note: '⚠️ リスク\nVIX：17.2（普通）\n\n市場は暴落しています。\n' }), 24));
});

// ── Rule 25 ──────────────────────────────────────────────
test('Rule25: 買付日に少数意見として「審査部は様子見を支持」と紹介しても検出しない', () => {
  const note = '👑 秘書室長所見\n\n審査部は様子見を支持しましたが、総合的に判断してSOXを採用しました。\n';
  assert.ok(!has(run({ note, decisions: buyDecision }), 25));
});
test('Rule25: 買付日に「様子見ではなく」の否定も検出しない', () => {
  const note = '👑 秘書室長所見\n\n今回は様子見ではなく打診買いを選びました。\n';
  assert.ok(!has(run({ note, decisions: buyDecision }), 25));
});
test('Rule25: 買付日に「今回は様子見とします」と書けば検出する', () => {
  const note = '👑 秘書室長所見\n\n今回は様子見とします。\n';
  assert.ok(has(run({ note, decisions: buyDecision }), 25));
});

// ── Rule 39 ──────────────────────────────────────────────
const shinBody = s => `😎 マーケット分析部（神谷シン）\n判断：打診\n要約：${s}\n推奨：\nSOX ¥10,000\n\n⚖️ 最終判断\n`;
const recsShin = [{ ...rec('マーケット分析部', 'ACCUMULATE', 'SOX'), amount: 10000 }];
const candsSoxSp = [cand('SOX'), cand('S&P500')];
test('Rule39: 他部署の提案を紹介する文は自分の提案とみなさない', () => {
  const note = shinBody('黒崎氏がS&P500を推奨するのに対し、私はSOXを提案します。');
  assert.ok(!has(run({ note, recs: recsShin, candidates: candsSoxSp }), 39));
});
test('Rule39: 自分の推奨と異なる資産を自分の提案として書けば検出する', () => {
  const note = shinBody('S&P500を提案します。');
  assert.ok(has(run({ note, recs: recsShin, candidates: candsSoxSp }), 39));
});

// ── Rule 43（2026-11-04 / 2026-10-30 実インシデント） ───────
const mc = (fg, env, body) => `📊 AI Capital Market Check\n\n😨 投資家心理\nFear & Greed：${fg}（恐怖）\n\n📉 市場環境\n${env}\n\n📌 今日の見どころ\n\n論点です。\n\n🌍 今日の市場\n\n${body}\n\n🎯 本日の買付候補\n`;
test('Rule43: 「過熱感や勢いではなく」の否定文は検出しない', () => {
  assert.ok(!has(run({ note: mc(19, '堅調', '本日の判断は、市場の過熱感や勢いではなく、資金配分の健全性を最優先した結果です。') }), 43));
});
test('Rule43: 恐怖圏なのに「市場は過熱している」と書けば検出する', () => {
  assert.ok(has(run({ note: mc(19, '堅調', '市場は過熱しています。') }), 43));
});
test('Rule43: 個別銘柄の「軟調」は市場環境ラベルとの矛盾とみなさない', () => {
  assert.ok(!has(run({ note: mc(40, '堅調', 'FANG+は軟調でした。') }), 43));
});
test('Rule43: 市場全体の「軟調」は市場環境「堅調」と矛盾として検出する', () => {
  assert.ok(has(run({ note: mc(40, '堅調', '株式市場は軟調でした。') }), 43));
});
test('Rule43: 「市場の過熱感による調整局面」(過熱は下落の原因として語られるだけ)は検出しない', () => {
  assert.ok(!has(run({ note: mc(20, '調整', '理由：直近高値から約21%下落し、市場の過熱感による調整局面を最も強く受けているため。') }), 43));
});
test('Rule43: 「過熱感が冷めて反落」も検出しない', () => {
  assert.ok(!has(run({ note: mc(20, '調整', '市場の過熱感が冷めて反落しました。') }), 43));
});
test('Rule43: 恐怖圏なのに「市場の過熱感が強まっています」は引き続き検出する', () => {
  assert.ok(has(run({ note: mc(20, '調整', '市場の過熱感が強まっています。') }), 43));
});
test('Rule43: 「過熱感という根拠が不足しています」（他部署への批判文）は検出しない（2026-11-11）', () => {
  const note = mc(33, '調整', 'VIXは落ち着いています。') +
    '\n🧐 審査部（鬼塚ガイ）\n判断：様子見\n要約：神谷のSOX買い推奨は、市場指標の過熱感という根拠が不足しています。\n';
  assert.ok(!has(run({ note }), 43));
});
