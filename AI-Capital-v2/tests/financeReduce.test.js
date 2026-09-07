'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildProposal } = require('../agents/finance');
const { reviewProposal, parseVerdict } = require('../agents/finance-review');

const TODAY = '2026-09-30';

// ── フィクスチャ ────────────────────────────────────────────
function pf({ cash, invested, nav, positions }) {
  return {
    cash: String(cash),
    invested: String(invested),
    total_assets: String(nav),
    cash_ratio: String(Math.round((cash / nav) * 1000) / 10),
    positions_json: JSON.stringify(positions),
  };
}
const pos = (name, cost, mv) => ({ name, cost_basis: cost, market_value: mv, unrealized_pl: mv - cost });

// 標準の active シナリオ: NAV 1,150万 / cash 207万(18%) / invested 943万
const BASE = {
  nav: 11_500_000,
  cash: 2_070_000,
  invested: 9_430_000,
};
// SOX: 原価200万 / 時価240万（+20%）→ alloc 25.5% ≫ 目標10%
const SOX_POS = pos('SOX', 2_000_000, 2_400_000);
// SOX を古いロット2本で構成（両方 30 日以上前）
const SOX_ORDERS = [
  { status: 'filled', asset_name: 'SOX', date: '2026-06-01', amount: '1200000' },
  { status: 'filled', asset_name: 'SOX', date: '2026-07-15', amount: '800000' },
];
const GOLD_ORDERS = [{ status: 'filled', asset_name: 'ゴールド', date: '2026-08-01', amount: '900000' }];

// ── T6: 五段クランプ ───────────────────────────────────────

test('T6.1 10% 上限が binding → ¥200,000 / bound=term2_pctCap', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [SOX_POS, pos('ゴールド', 900_000, 930_000)] }),
    orders: [...SOX_ORDERS, ...GOLD_ORDERS],
  });
  assert.equal(r.status, 'proposed');
  assert.equal(r.asset_name, 'SOX');
  assert.equal(r.amount, 200_000);
  assert.equal(r.clamp.bound, 'term2_pctCap');
});

test('T6.2 25% 回復ギャップが binding → ¥50,000 / bound=term1_recoverGap', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, cash: 2_825_000, positions: [SOX_POS] }), // 25%まで残 50,000
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'proposed');
  assert.equal(r.amount, 50_000);
  assert.equal(r.clamp.bound, 'term1_recoverGap');
});

test('T6.3 30 日以上ロット原価が binding → ¥60,000 / bound=term3_agedLots', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [SOX_POS] }),
    orders: [
      { status: 'filled', asset_name: 'SOX', date: '2026-06-01', amount: '60000' },   // aged
      { status: 'filled', asset_name: 'SOX', date: '2026-09-25', amount: '1940000' },  // 5d, not aged
    ],
  });
  assert.equal(r.status, 'proposed');
  assert.equal(r.amount, 60_000);
  assert.equal(r.clamp.bound, 'term3_agedLots');
});

test('T6.4 目標配分フロアが binding → ¥45,000（¥1,000 丸め）/ bound=term4_targetFloor', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [pos('SOX', 800_000, 1_000_000)] }), // alloc 10.6% → 目標10% を僅かに超過
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'proposed');
  assert.equal(r.clamp.bound, 'term4_targetFloor');
  assert.equal(r.amount, 45_000);
});

test('T6.5 現在比率がちょうど目標（10.0%）→ no_action（超過していない）', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [pos('SOX', 800_000, 943_000)] }), // 943,000 / 9,430,000 = 10.0%
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'no_action');
  assert.match(r.reason, /銘柄がありませんでした/);
});

test('T6.6 目標未達（9%）だが含み益 +30% → no_action（利確理由でも目標割れ銘柄は対象外）', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [pos('SOX', 650_000, 848_700)] }), // alloc 9.0%
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'no_action');
});

test('T6.7 R2 ローリング上限が binding → ¥175,000 / bound=term5_r2', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [SOX_POS] }),
    orders: [
      ...SOX_ORDERS,
      ...GOLD_ORDERS,
      { status: 'sold', asset_name: 'ゴールド', date: '2026-09-20', amount: '400000' }, // 別銘柄の売却で rolling=400,000
    ],
  });
  assert.equal(r.status, 'proposed');
  assert.equal(r.rolling_30d_reduced, 400_000);
  assert.equal(r.amount, 175_000); // NAV*5% (575,000) − 400,000
  assert.equal(r.clamp.bound, 'term5_r2');
});

test('T6.8 R2 上限を使い切り → no_action（30日調整上限に到達）', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [SOX_POS] }),
    orders: [
      ...SOX_ORDERS,
      ...GOLD_ORDERS,
      { status: 'sold', asset_name: 'ゴールド', date: '2026-09-20', amount: '575000' },
    ],
  });
  assert.equal(r.status, 'no_action');
  assert.match(r.reason, /上限/);
});

test('T6.9 各クランプ後 ¥1,000 未満 → no_action', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, cash: 2_874_500, positions: [SOX_POS] }), // 25%まで残 500
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'no_action');
  assert.match(r.reason, /下限/);
});

test('T6.11 10% 上限は cost_basis 基準（market_value ではない）', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [pos('SOX', 1_000_000, 3_000_000)] }), // 含み益 +200%
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'proposed');
  // 10% of cost 1,000,000 = 100,000（time value 3,000,000 の 10% ではない）
  assert.equal(r.amount, 100_000);
  assert.equal(r.clamp.bound, 'term2_pctCap');
});

test('T6.12 R2 上限は NAV に連動する', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ nav: 13_000_000, cash: 2_000_000, invested: 11_000_000, positions: [SOX_POS] }),
    orders: [
      ...SOX_ORDERS, ...GOLD_ORDERS,
      { status: 'sold', asset_name: 'ゴールド', date: '2026-09-21', amount: '600000' },
    ],
  });
  assert.equal(r.status, 'proposed');
  assert.equal(r.amount, 50_000); // 13,000,000*5% (650,000) − 600,000
  assert.equal(r.clamp.bound, 'term5_r2');
});

// ── T3: 含み益ゲート ───────────────────────────────────────

test('T3.1 含み益 +14.9% は候補から除外（単独候補なら no_action）', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [pos('SOX', 1_000_000, 1_149_000)] }), // +14.9%
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'no_action');
});

test('T3.2 含み益ちょうど +15.0% は対象（境界含む）', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [pos('SOX', 1_000_000, 1_150_000)] }), // +15.0%, alloc 12.2% > 10
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'proposed');
  assert.equal(r.asset_name, 'SOX');
});

test('T3.3 含み損銘柄は対象外（損切りしない）', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [pos('SOX', 1_000_000, 950_000)] }), // −5%
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'no_action');
});

test('T3.4 NAV 欠損（market_value == cost_basis, pl == 0）は含み益0%扱いで除外', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [pos('SOX', 1_000_000, 1_000_000)] }),
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'no_action');
});

// ── T5: 提案クールダウン（起点＝提案日） ───────────────────

test('T5.1 前回 proposed が 6 日前 → no_action（クールダウン中）', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [SOX_POS] }),
    orders: SOX_ORDERS,
    prevRows: [{ date: '2026-09-24', status: 'proposed' }],
  });
  assert.equal(r.status, 'no_action');
  assert.match(r.reason, /クールダウン/);
});

test('T5.2 前回 proposed が 7 日前 → 提案可', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [SOX_POS] }),
    orders: SOX_ORDERS,
    prevRows: [{ date: '2026-09-23', status: 'proposed' }],
  });
  assert.equal(r.status, 'proposed');
});

test('T5.3 3 日前の rejected でもクールダウン起点になる（却下でリセットしない）', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [SOX_POS] }),
    orders: SOX_ORDERS,
    prevRows: [{ date: '2026-09-27', status: 'rejected' }],
  });
  assert.equal(r.status, 'no_action');
  assert.match(r.reason, /クールダウン/);
});

test('T5.4 no_action / monitoring 行はクールダウン起点にしない', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [SOX_POS] }),
    orders: SOX_ORDERS,
    prevRows: [
      { date: '2026-09-29', status: 'no_action' },
      { date: '2026-09-28', status: 'monitoring' },
    ],
  });
  assert.equal(r.status, 'proposed');
});

// ── T7: 対象選定・理由文 ───────────────────────────────────

test('T7.1 目標超過幅が最大の銘柄を選ぶ', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({
      ...BASE,
      positions: [
        pos('SOX', 2_000_000, 2_400_000),   // alloc 25.5%, over +15.5
        pos('FANG+', 1_000_000, 1_200_000), // alloc 12.7%, over +2.7
      ],
    }),
    orders: [
      ...SOX_ORDERS,
      { status: 'filled', asset_name: 'FANG+', date: '2026-06-10', amount: '1000000' },
    ],
  });
  assert.equal(r.status, 'proposed');
  assert.equal(r.asset_name, 'SOX');
});

test('T7.2 全銘柄が目標配分以下 → no_action（調整不要・長期優先）', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({
      ...BASE,
      positions: [pos('SOX', 500_000, 700_000), pos('ゴールド', 400_000, 500_000)], // どちらも alloc < 10%
    }),
    orders: [...SOX_ORDERS, ...GOLD_ORDERS],
  });
  assert.equal(r.status, 'no_action');
});

test('T7.3 目標超過幅が同率 → asset_name 昇順で決定的に選択', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({
      ...BASE,
      positions: [
        pos('ゴールド', 1_000_000, 1_414_500), // alloc 15.0%, target 10, over +5.0
        pos('FANG+',   1_000_000, 1_414_500), // alloc 15.0%, target 10, over +5.0
      ],
    }),
    orders: [
      { status: 'filled', asset_name: 'ゴールド', date: '2026-06-01', amount: '1000000' },
      { status: 'filled', asset_name: 'FANG+',   date: '2026-06-01', amount: '1000000' },
    ],
  });
  assert.equal(r.status, 'proposed');
  assert.equal(r.asset_name, 'FANG+'); // 'FANG+' < 'ゴールド'
});

test('T7.4 提案理由は資金余力・集中度・含み益のみで構成し、相場予測語を含まない', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, positions: [SOX_POS] }),
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'proposed');
  assert.doesNotMatch(r.reason, /下落|暴落|急落|見通し|相場が|上昇局面|反発/);
  assert.match(r.reason, /現金比率/);
  assert.match(r.reason, /目標配分/);
  assert.match(r.reason, /含み益/);
});

// ── ガード ─────────────────────────────────────────────────

test('pf が null なら no_action（例外を投げない）', () => {
  assert.doesNotThrow(() => buildProposal({ date: TODAY, pf: null, orders: [] }));
  assert.equal(buildProposal({ date: TODAY, pf: null, orders: [] }).status, 'no_action');
});

test('amount は必ず ¥1,000 単位（切り捨て）', () => {
  const r = buildProposal({
    date: TODAY,
    pf: pf({ ...BASE, cash: 2_836_500, positions: [SOX_POS] }), // 25%まで残 38,500
    orders: SOX_ORDERS,
  });
  assert.equal(r.status, 'proposed');
  assert.equal(r.amount % 1000, 0);
  assert.equal(r.amount, 38_000);
});

// ── T8（部分）: 承認ゲートのパース・fail-closed ───────────

test('T8: parseVerdict は正しい JSON の APPROVE/REJECT を読む', () => {
  assert.deepEqual(parseVerdict('{"verdict":"APPROVE","reason":"妥当"}'), { verdict: 'APPROVE', reason: '妥当' });
  assert.deepEqual(parseVerdict('前置き {"verdict":"REJECT","reason":"過大"} 後'), { verdict: 'REJECT', reason: '過大' });
});

test('T8: parseVerdict はパース不能なら null（呼び出し側で fail-closed）', () => {
  assert.equal(parseVerdict('よくわかりません'), null);
  assert.equal(parseVerdict('{"verdict":"MAYBE"}'), null);
  assert.equal(parseVerdict(undefined), null);
});

const GOOD_PROPOSAL = {
  status: 'proposed', asset_name: 'SOX', amount: 200000, gain_pct: 20,
  weight_before_inv: 25.5, weight_after_inv: 23.4, target_weight: 10,
  cash_ratio_before: 18, rolling_30d_reduced: 0, reason: 'テスト提案',
};

test('T8.1 risk・audit とも APPROVE → approved=true', async () => {
  const ask = async () => '{"verdict":"APPROVE","reason":"ok"}';
  const r = await reviewProposal({ proposal: GOOD_PROPOSAL, ask });
  assert.equal(r.approved, true);
  assert.equal(r.failClosed, false);
});

test('T8.2 いずれか REJECT → approved=false', async () => {
  let n = 0;
  const ask = async () => (++n === 1
    ? '{"verdict":"APPROVE","reason":"ok"}'
    : '{"verdict":"REJECT","reason":"過大"}');
  const r = await reviewProposal({ proposal: GOOD_PROPOSAL, ask });
  assert.equal(r.approved, false);
  assert.equal(r.audit.verdict, 'REJECT');
});

test('T8.4 ask が throw → fail-closed（approved=false, failClosed=true）', async () => {
  const ask = async () => { throw new Error('timeout'); };
  const r = await reviewProposal({ proposal: GOOD_PROPOSAL, ask });
  assert.equal(r.approved, false);
  assert.equal(r.failClosed, true);
});

test('T8.5 応答が APPROVE/REJECT を含まない自由文 → fail-closed', async () => {
  const ask = async () => 'うーん、判断が難しいですね';
  const r = await reviewProposal({ proposal: GOOD_PROPOSAL, ask });
  assert.equal(r.approved, false);
  assert.equal(r.failClosed, true);
});

test('T8: proposal が proposed でない / 欠損 → fail-closed で REJECT', async () => {
  const ask = async () => '{"verdict":"APPROVE"}';
  for (const bad of [null, { status: 'no_action' }, { status: 'proposed', asset_name: '', amount: 0 }]) {
    const r = await reviewProposal({ proposal: bad, ask });
    assert.equal(r.approved, false);
    assert.equal(r.failClosed, true);
  }
});
