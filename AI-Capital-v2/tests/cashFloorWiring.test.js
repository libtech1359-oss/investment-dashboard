'use strict';

/**
 * cashFloorWiring.test.js — lib/signalAggregator.js への現金フロア配線の統合テスト
 *
 * sheets モジュールをスタブして BUY シナリオを流し、final_decisions へ書かれる
 * amount / final_signal / reason が現金比率に応じて期待どおり変わることを確認する。
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const sheets = require('../lib/sheets');
const agg    = require('../lib/signalAggregator');

// スタブ前の実装を退避
const orig = {
  getRowsByDate:      sheets.getRowsByDate,
  getLatestRowAsOf:   sheets.getLatestRowAsOf,
  getRowsByDateRange: sheets.getRowsByDateRange,
  upsertRow:          sheets.upsertRow,
};

function install({ cashRatio, cash = 1_000_000, crash = false }) {
  let captured = null;

  sheets.getRowsByDate = async (name) => {
    if (name === 'agent_votes') {
      return [
        { signal: 'BUY',        confidence: '60' },
        { signal: 'BUY',        confidence: '60' },
        { signal: 'BUY',        confidence: '60' },
        { signal: 'ACCUMULATE', confidence: '50' },
      ];
    }
    if (name === 'candidate_assets') return [{ asset_name: 'S&P500', rank: '1' }];
    if (name === 'agent_recommendations' || name === 'department_recommendations') return [];
    return [];
  };

  sheets.getLatestRowAsOf = async (name) => {
    if (name === 'portfolio_status') {
      return {
        cash:           String(cash),
        cash_ratio:     String(cashRatio),
        total_assets:   '10000000',
        invested:       String(10_000_000 - cash),
        positions_json: '[]',
      };
    }
    if (name === 'market_data') {
      return {
        vix:        '18',
        fear_greed: crash ? '20'   : '55',
        nasdaq100:  crash ? '-4.0' : '0.5',
      };
    }
    return null;
  };

  sheets.getRowsByDateRange = async () => [];
  sheets.upsertRow = async (name, _keys, data) => {
    if (name === 'final_decisions') captured = data;
    return { ok: true };
  };

  return () => captured;
}

test.afterEach(() => {
  Object.assign(sheets, orig);
});

// base 買付額 = cash×3% フォールバック（部署推薦なし）= 1,000,000 × 3% = 30,000

test('W1 現金比率25%（SOFT超）→ 買付額そのまま・BUY維持', async () => {
  const get = install({ cashRatio: 25 });
  await agg.run('2026-09-08');
  const d = get();
  assert.equal(d.final_signal, 'BUY');
  assert.equal(d.target_asset, 'S&P500');
  assert.equal(d.amount, '30000');
});

test('W2 現金比率15%（逓減帯）→ factor0.5 で 15,000 に抑制・BUY維持', async () => {
  const get = install({ cashRatio: 15 });
  await agg.run('2026-09-08');
  const d = get();
  assert.equal(d.final_signal, 'BUY');
  assert.equal(d.target_asset, 'S&P500');
  assert.equal(d.amount, '15000');
  assert.match(d.reason, /現金フロア/);
});

test('W3 現金比率8%・暴落なし（HARD以下）→ 買付ゼロ → WAIT へ降格', async () => {
  const get = install({ cashRatio: 8, crash: false });
  await agg.run('2026-09-08');
  const d = get();
  assert.equal(d.final_signal, 'WAIT');
  assert.equal(d.target_asset, '');
  assert.equal(d.amount, '');
  assert.match(d.reason, /現金比率8%が下限10%以下/);
});

test('W4 現金比率8%・暴落シグナルあり（floor→5）→ factor0.2 で 6,000・BUY維持', async () => {
  const get = install({ cashRatio: 8, crash: true });
  await agg.run('2026-09-08');
  const d = get();
  assert.equal(d.final_signal, 'BUY');
  assert.equal(d.amount, '6000');
});

test('W5 現金比率4%・暴落シグナルありでも CRASH下限以下 → 買付ゼロ → WAIT', async () => {
  const get = install({ cashRatio: 4, crash: true });
  await agg.run('2026-09-08');
  const d = get();
  assert.equal(d.final_signal, 'WAIT');
  assert.equal(d.amount, '');
});

test('W6 現金比率30%（通常運用）→ 一切変更なし（回帰ガード）', async () => {
  const get = install({ cashRatio: 30 });
  await agg.run('2026-09-08');
  const d = get();
  assert.equal(d.final_signal, 'BUY');
  assert.equal(d.amount, '30000');
  assert.doesNotMatch(d.reason, /現金フロア/);
});
