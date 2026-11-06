'use strict';

/**
 * smallLotWiring.test.js — lib/signalAggregator.js への小口買付の配線テスト（統合）
 *
 * sheets をスタブして日次の票・推薦・市場・ポートフォリオを流し、final_decisions へ書かれる
 * final_signal / amount / reason が確定仕様どおりになることを確認する。
 *
 * 部署票: マーケット(神谷) / リスク(黒崎) / 審査(鬼塚) / ポートフォリオ(アオイ)
 * 部署の推薦額は各¥300,000（平均が大きくても小口上限を超えないことを確認する）
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const sheets = require('../lib/sheets');
const agg    = require('../lib/signalAggregator');

const orig = {
  getRowsByDate:      sheets.getRowsByDate,
  getLatestRowAsOf:   sheets.getLatestRowAsOf,
  getRowsByDateRange: sheets.getRowsByDateRange,
  upsertRow:          sheets.upsertRow,
};

const MKT  = 'マーケット分析部';
const RISK = 'リスク管理部';
const AUD  = '審査部';
const AOI  = 'ポートフォリオ管理部';

const vote = (department, signal, confidence = 60) => ({ department, signal, confidence: String(confidence) });
const rec  = (department, amount = 300000, type = 'ACCUMULATE') => ({
  department, asset_name: 'S&P500', amount: String(amount), confidence: '60', recommendation_type: type,
});

/**
 * @param {object} o
 * @param {number} o.cashRatio  現金比率(%)
 * @param {number} [o.cash]     現金残高(円)
 * @param {number} [o.fg]       Fear & Greed
 * @param {number} [o.nasdaq]   NASDAQ前日比(%)
 * @param {Array}  o.votes
 * @param {Array}  o.recs
 * @param {number|string} [o.ruleScore] 採用銘柄(S&P500)のcandidate_assets.score（0-100）
 */
function install({ cashRatio, cash = 1_700_000, fg = 28, nasdaq = 0.3, votes, recs, ruleScore = 10 }) {
  let captured = null;

  sheets.getRowsByDate = async (name) => {
    if (name === 'agent_votes') return votes;
    if (name === 'candidate_assets') {
      return [
        { asset_name: 'S&P500', full_name: 'S&P500', rank: '1', score: String(ruleScore) },
        { asset_name: 'ゴールド', full_name: 'ゴールド', rank: '2', score: '5' },
      ];
    }
    if (name === 'agent_recommendations') return recs;
    return [];
  };
  sheets.getLatestRowAsOf = async (name) => {
    if (name === 'portfolio_status') {
      return {
        cash: String(cash), cash_ratio: String(cashRatio), total_assets: '11500000',
        invested: String(11_500_000 - cash), positions_json: '[]',
      };
    }
    if (name === 'market_data') return { vix: '18', fear_greed: String(fg), nasdaq100: String(nasdaq) };
    return null;
  };
  sheets.getRowsByDateRange = async () => [];
  sheets.upsertRow = async (name, _keys, data) => {
    if (name === 'final_decisions') captured = data;
    return { ok: true };
  };
  return () => captured;
}

test.afterEach(() => { Object.assign(sheets, orig); });

// ── 基本: 他3部署のうち2票がACCUMULATE + アオイACCUMULATE、F&G=28、現金15% ──
test('SLW-1 現金15%・F&G28・他2票買い＋アオイ買い → ACCUMULATE ¥10,000（推薦額の平均¥30万でも小口上限）', async () => {
  const get = install({
    cashRatio: 15, fg: 28,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'ACCUMULATE'), vote(AUD, 'WAIT'), vote(AOI, 'ACCUMULATE')],
    recs:  [rec(MKT), rec(RISK), rec(AOI)],
  });
  await agg.run('2026-11-09');
  const d = get();
  assert.equal(d.final_signal, 'ACCUMULATE');
  assert.equal(d.target_asset, 'S&P500');
  assert.equal(d.amount, '10000');
  assert.match(d.reason, /小口買付/);
  assert.match(d.reason, /¥10,000/);
  assert.doesNotMatch(d.reason, /現金フロアにより/, '途中経過のフロア額ではなく最終額の説明に一本化されているはず');
});

// ── アオイの買い票が条件未達でWAIT扱い（F&G>30）→ 2対2のため従来のタイブレーク（現金比率50%未満でWAIT）──
test('SLW-2 F&G=45でアオイの買い票が無効 → 2対2は既存タイブレークに委ね、WAIT（理由はタイブレークのまま）', async () => {
  const get = install({
    cashRatio: 15, fg: 45,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'ACCUMULATE'), vote(AUD, 'WAIT'), vote(AOI, 'ACCUMULATE')],
    recs:  [rec(MKT), rec(RISK), rec(AOI)],
  });
  await agg.run('2026-11-09');
  const d = get();
  assert.equal(d.final_signal, 'WAIT');
  assert.equal(d.amount, '');
  assert.match(d.reason, /タイブレーク/);
});

// ── アオイの買い票を無効にしたことで結果が変わった場合は、その理由を残す ──
test('SLW-3 他の買い票が1票のみでアオイの買い票が無効 → WAIT、理由に小口買付条件を明記', async () => {
  const get = install({
    cashRatio: 15, fg: 28,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'WAIT'), vote(AUD, 'WAIT'), vote(AOI, 'ACCUMULATE')],
    recs:  [rec(MKT), rec(AOI)],
  });
  await agg.run('2026-11-09');
  const d = get();
  assert.equal(d.final_signal, 'WAIT');
  assert.match(d.reason, /小口買付条件/);
  assert.match(d.reason, /見送り扱い/);
});

// ── 他3部署が全員一致の買い（アオイはWAIT）→ 従来どおり成立。小口キャップで¥10,000 ──
test('SLW-4 他3部署が全員買い・アオイWAIT・現金15% → ACCUMULATE（従来基準で成立）、金額は小口上限¥10,000', async () => {
  const get = install({
    cashRatio: 15, fg: 45, ruleScore: 10,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'ACCUMULATE'), vote(AUD, 'ACCUMULATE'), vote(AOI, 'WAIT')],
    recs:  [rec(MKT), rec(RISK), rec(AUD)],
  });
  await agg.run('2026-11-09');
  const d = get();
  assert.equal(d.final_signal, 'ACCUMULATE');
  assert.equal(d.amount, '10000');
});

// ── 強根拠: 実効スコア0.75以上 かつ 採用銘柄のRuleスコア20以上 → ¥30,000 ──
test('SLW-5 実効スコア0.75・採用銘柄Rule 25 → ¥30,000（強根拠）', async () => {
  const get = install({
    cashRatio: 15, fg: 45, ruleScore: 25,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'ACCUMULATE'), vote(AUD, 'ACCUMULATE'), vote(AOI, 'WAIT')], // (3×0.6)/(4×0.6)=0.75
    recs:  [rec(MKT), rec(RISK), rec(AUD)],
  });
  await agg.run('2026-11-09');
  const d = get();
  assert.equal(d.final_signal, 'ACCUMULATE');
  assert.equal(d.amount, '30000');
  assert.match(d.reason, /根拠が強い/);
});

test('SLW-6 実効スコア0.75でも採用銘柄のRuleが19 → ¥10,000（強根拠にならない）', async () => {
  const get = install({
    cashRatio: 15, fg: 45, ruleScore: 19,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'ACCUMULATE'), vote(AUD, 'ACCUMULATE'), vote(AOI, 'WAIT')],
    recs:  [rec(MKT), rec(RISK), rec(AUD)],
  });
  await agg.run('2026-11-09');
  assert.equal(get().amount, '10000');
});

test('SLW-7 強根拠の判定は採用銘柄自身のRuleスコア（上位候補ではない）を使う', async () => {
  // 部署が推薦するのは rank2 のゴールド。rank1 (S&P500) のスコアが高くても、ゴールド(5)は強根拠にならない
  const get = install({
    cashRatio: 15, fg: 45, ruleScore: 90,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'ACCUMULATE'), vote(AUD, 'ACCUMULATE'), vote(AOI, 'WAIT')],
    recs:  ['マーケット分析部', 'リスク管理部', '審査部'].map(department => ({
      department, asset_name: 'ゴールド', amount: '300000', confidence: '60', recommendation_type: 'ACCUMULATE',
    })),
  });
  await agg.run('2026-11-09');
  const d = get();
  assert.equal(d.target_asset, 'ゴールド');
  assert.equal(d.amount, '10000');
});

// ── 現金20%以上は従来どおり（キャップなし・アオイの票もそのまま）──
test('SLW-8 現金25% → 小口キャップもアオイの条件も適用されない（従来どおり）', async () => {
  const get = install({
    cashRatio: 25, fg: 55,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'ACCUMULATE'), vote(AUD, 'WAIT'), vote(AOI, 'ACCUMULATE')],
    recs:  [rec(MKT), rec(RISK), rec(AOI)],
  });
  await agg.run('2026-11-09');
  const d = get();
  assert.equal(d.final_signal, 'ACCUMULATE');
  assert.equal(d.amount, '300000');
});

// ── 現金10%以下は買付停止、暴落時は5%まで（5〜10%帯は¥10,000固定）──
test('SLW-9 現金9%・暴落なし → WAIT（原則WAIT）', async () => {
  const get = install({
    cashRatio: 9, fg: 28,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'ACCUMULATE'), vote(AUD, 'ACCUMULATE'), vote(AOI, 'ACCUMULATE')],
    recs:  [rec(MKT), rec(RISK), rec(AUD), rec(AOI)],
  });
  await agg.run('2026-11-09');
  const d = get();
  assert.equal(d.final_signal, 'WAIT');
  assert.equal(d.amount, '');
});

test('SLW-10 現金8%・暴落（F&G20）→ ACCUMULATE ¥10,000固定（強根拠でも¥30,000にしない）', async () => {
  const get = install({
    cashRatio: 8, fg: 20, nasdaq: -1, ruleScore: 60,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'ACCUMULATE'), vote(AUD, 'ACCUMULATE'), vote(AOI, 'ACCUMULATE')],
    recs:  [rec(MKT), rec(RISK), rec(AUD), rec(AOI)],
  });
  await agg.run('2026-11-09');
  const d = get();
  assert.equal(d.final_signal, 'ACCUMULATE');
  assert.equal(d.amount, '10000');
});

test('SLW-11 現金4%・暴落 → WAIT（最終下限5%以下）', async () => {
  const get = install({
    cashRatio: 4, fg: 20, nasdaq: -1,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'ACCUMULATE'), vote(AUD, 'ACCUMULATE'), vote(AOI, 'ACCUMULATE')],
    recs:  [rec(MKT), rec(RISK), rec(AUD), rec(AOI)],
  });
  await agg.run('2026-11-09');
  assert.equal(get().final_signal, 'WAIT');
});

// ── 従来の投資判断基準は緩めない: 実効スコアが0.5未満なら買わない ──
test('SLW-12 部署票が弱い日（買い1票のみ）は小口でも買わない', async () => {
  const get = install({
    cashRatio: 15, fg: 20, nasdaq: -1,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'WAIT'), vote(AUD, 'WAIT'), vote(AOI, 'WAIT')],
    recs:  [rec(MKT)],
  });
  await agg.run('2026-11-09');
  const d = get();
  assert.equal(d.final_signal, 'WAIT');
  assert.equal(d.amount, '');
});

// ── 2対2の同票は既存のタイブレーク（現金比率50%以上が条件）を維持 ──
test('SLW-13 アオイが条件を満たさず2対2になった日: 従来のタイブレークが評価され、現金15%ではWAIT', async () => {
  const get = install({
    cashRatio: 15, fg: 28,
    votes: [vote(MKT, 'ACCUMULATE'), vote(RISK, 'WAIT'), vote(AUD, 'ACCUMULATE'), vote(AOI, 'WAIT')],
    recs:  [rec(MKT), rec(AUD)],
  });
  await agg.run('2026-11-09');
  const d = get();
  assert.equal(d.final_signal, 'WAIT');
  assert.match(d.reason, /タイブレーク/);
});

// ── 元のagent_votesは変更しない（実効票は集計内でのみ使う）──
test('SLW-14 agent_votes の元データ（アオイの買い票）は書き換えられない', async () => {
  const votes = [vote(MKT, 'ACCUMULATE'), vote(RISK, 'WAIT'), vote(AUD, 'WAIT'), vote(AOI, 'ACCUMULATE')];
  const snapshot = JSON.stringify(votes);
  install({ cashRatio: 15, fg: 28, votes, recs: [rec(MKT), rec(AOI)] });
  await agg.run('2026-11-09');
  assert.equal(JSON.stringify(votes), snapshot);
});
