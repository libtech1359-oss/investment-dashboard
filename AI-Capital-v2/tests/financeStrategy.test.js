'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const fs = require('../config/financeStrategy');

// ── T1: 発動状態マシン（ヒステリシス） ───────────────────────
// 仕様: 発動 20% 未満 / 回復 25% 以上 / 20〜25% はモード据え置き / 2 連続 <20% で active

test('T1.1 date < PUBLIC_FROM は inactive', () => {
  assert.equal(fs.resolveMode({ date: '2026-08-30', cashRatioPct: 10, prevMode: 'monitoring' }), 'inactive');
});

test('T1.2 prevMode=monitoring・今回19.9%・前回19.9% → active（2 連続 <20%）', () => {
  assert.equal(
    fs.resolveMode({ date: '2026-09-01', cashRatioPct: 19.9, prevMode: 'monitoring', prevCashRatioPct: 19.9 }),
    'active',
  );
});

test('T1.3 prevMode=monitoring・今回19.9%・前回不明 → monitoring（2 連続要件）', () => {
  assert.equal(
    fs.resolveMode({ date: '2026-09-01', cashRatioPct: 19.9, prevMode: 'monitoring', prevCashRatioPct: null }),
    'monitoring',
  );
});

test('T1.4 prevMode=monitoring・22% → monitoring（20〜25% 据え置き）', () => {
  assert.equal(
    fs.resolveMode({ date: '2026-09-01', cashRatioPct: 22, prevMode: 'monitoring', prevCashRatioPct: 19 }),
    'monitoring',
  );
});

test('T1.5 prevMode=active・22% → active（据え置き）', () => {
  assert.equal(fs.resolveMode({ date: '2026-09-01', cashRatioPct: 22, prevMode: 'active' }), 'active');
});

test('T1.6 prevMode=active・25% → monitoring（境界で解除）', () => {
  assert.equal(fs.resolveMode({ date: '2026-09-01', cashRatioPct: 25, prevMode: 'active' }), 'monitoring');
});

test('T1.7 prevMode=active・24.9% → active', () => {
  assert.equal(fs.resolveMode({ date: '2026-09-01', cashRatioPct: 24.9, prevMode: 'active' }), 'active');
});

test('T1.8 初回（prevMode 不明）・23% → monitoring（20% 割れ未経験）', () => {
  assert.equal(fs.resolveMode({ date: '2026-09-01', cashRatioPct: 23, prevMode: undefined, prevCashRatioPct: null }), 'monitoring');
});

test('T1.8b 初回・19% だが前回なし → monitoring（1 回目のみ・active にしない）', () => {
  assert.equal(fs.resolveMode({ date: '2026-09-01', cashRatioPct: 19, prevMode: undefined, prevCashRatioPct: null }), 'monitoring');
});

test('現金比率が数値化できないときは状態維持（安全側）', () => {
  assert.equal(fs.resolveMode({ date: '2026-09-01', cashRatioPct: '', prevMode: 'active' }), 'active');
  assert.equal(fs.resolveMode({ date: '2026-09-01', cashRatioPct: null, prevMode: 'monitoring' }), 'monitoring');
});

// ── isPublic ────────────────────────────────────────────────
test('isPublic: 2026-08-31 以降のみ true', () => {
  assert.equal(fs.isPublic('2026-08-30'), false);
  assert.equal(fs.isPublic('2026-08-31'), true);
  assert.equal(fs.isPublic('2026-12-01'), true);
});

// ── isDryRun（安全側デフォルト） ────────────────────────────
test('isDryRun: FINANCE_DRY_RUN が明示的に false のときだけ本番。未設定・その他は dry-run', () => {
  const orig = process.env.FINANCE_DRY_RUN;
  try {
    delete process.env.FINANCE_DRY_RUN;
    assert.equal(fs.isDryRun(), true, '未設定 → dry-run');
    process.env.FINANCE_DRY_RUN = 'true';
    assert.equal(fs.isDryRun(), true);
    process.env.FINANCE_DRY_RUN = 'yes';
    assert.equal(fs.isDryRun(), true, "'false' 以外は dry-run");
    process.env.FINANCE_DRY_RUN = 'false';
    assert.equal(fs.isDryRun(), false, "明示的 'false' → 本番");
  } finally {
    if (orig === undefined) delete process.env.FINANCE_DRY_RUN;
    else process.env.FINANCE_DRY_RUN = orig;
  }
});

// ── パラメータが config から読めること（ハードコード無し） ──
test('パラメータ一覧が config に存在する', () => {
  for (const k of ['ACTIVATE_BELOW_PCT', 'DEACTIVATE_AT_PCT', 'MIN_GAIN_PCT', 'MIN_LOT_AGE_DAYS',
    'REDUCE_COOLDOWN_DAYS', 'MAX_REDUCE_RATIO', 'MAX_REDUCE_NAV_RATIO_30D', 'ROLLING_WINDOW_DAYS']) {
    assert.equal(typeof fs[k], 'number', `${k} が数値`);
  }
  assert.equal(fs.ACTIVATE_BELOW_PCT, 20);
  assert.equal(fs.DEACTIVATE_AT_PCT, 25);
  assert.equal(fs.MAX_REDUCE_RATIO, 0.10);
  assert.equal(fs.MAX_REDUCE_NAV_RATIO_30D, 0.05);
});

// ── T2: 記事登場ゲート（resolveArticleVisibility）─────────────
// 既定: ARTICLE_FROM=2026-09-07 / ARTICLE_MONITORING_MARGIN_PCT=2（発動ライン20% → 接近しきい22%）

test('T2.0 isArticleVisible: ARTICLE_FROM 境界', () => {
  assert.equal(fs.isArticleVisible('2026-09-06'), false);
  assert.equal(fs.isArticleVisible('2026-09-07'), true);
  assert.equal(fs.isArticleVisible('2026-10-01'), true);
});

const monRow = (cr) => ({ mode: 'monitoring', status: 'monitoring', cash_ratio_before: String(cr) });

test('T2.1 ARTICLE_FROM 前 → 非表示', () => {
  const r = fs.resolveArticleVisibility({ date: '2026-09-06', financeRow: monRow(15), cashRatioPct: 15 });
  assert.equal(r.show, false);
});

test('T2.2 finance_proposals 当日行なし → 非表示', () => {
  assert.equal(fs.resolveArticleVisibility({ date: '2026-09-10', financeRow: null, cashRatioPct: 15 }).show, false);
});

test('T2.3 mode=inactive / 空 → 非表示', () => {
  assert.equal(fs.resolveArticleVisibility({ date: '2026-09-10', financeRow: { mode: 'inactive' }, cashRatioPct: 15 }).show, false);
  assert.equal(fs.resolveArticleVisibility({ date: '2026-09-10', financeRow: { mode: '' }, cashRatioPct: 15 }).show, false);
});

test('T2.4 monitoring・現金比率25%（余力あり）→ 非表示', () => {
  const r = fs.resolveArticleVisibility({ date: '2026-09-10', financeRow: monRow(25), cashRatioPct: 25 });
  assert.equal(r.show, false);
});

test('T2.5 monitoring・現金比率22%ちょうど（接近しきい）→ 表示 tone=monitoring', () => {
  const r = fs.resolveArticleVisibility({ date: '2026-09-10', financeRow: monRow(22), cashRatioPct: 22 });
  assert.equal(r.show, true);
  assert.equal(r.tone, 'monitoring');
});

test('T2.6 monitoring・現金比率22.1% → 非表示', () => {
  assert.equal(fs.resolveArticleVisibility({ date: '2026-09-10', financeRow: monRow(22.1), cashRatioPct: 22.1 }).show, false);
});

test('T2.7 monitoring・現金比率16.8% → 表示 tone=monitoring', () => {
  const r = fs.resolveArticleVisibility({ date: '2026-09-10', financeRow: monRow(16.8), cashRatioPct: 16.8 });
  assert.equal(r.show, true);
  assert.equal(r.tone, 'monitoring');
});

test('T2.8 monitoring・cashRatioPct 未指定なら financeRow.cash_ratio_before にフォールバック', () => {
  const r = fs.resolveArticleVisibility({ date: '2026-09-10', financeRow: monRow(18), cashRatioPct: null });
  assert.equal(r.show, true);
});

test('T2.9 monitoring・現金比率が数値化不可 → 非表示（安全側）', () => {
  const r = fs.resolveArticleVisibility({ date: '2026-09-10', financeRow: { mode: 'monitoring', cash_ratio_before: '' }, cashRatioPct: null });
  assert.equal(r.show, false);
});

test('T2.10 active・status=no_action → 表示 tone=active', () => {
  const r = fs.resolveArticleVisibility({ date: '2026-09-10', financeRow: { mode: 'active', status: 'no_action' }, cashRatioPct: 15 });
  assert.equal(r.show, true);
  assert.equal(r.tone, 'active');
});

test('T2.11 active・status=proposed/approved/rejected/executed* → 表示 tone=proposal', () => {
  for (const st of ['proposed', 'approved', 'rejected', 'executed', 'executed_dryrun']) {
    const r = fs.resolveArticleVisibility({ date: '2026-09-10', financeRow: { mode: 'active', status: st }, cashRatioPct: 15 });
    assert.equal(r.show, true, st);
    assert.equal(r.tone, 'proposal', st);
  }
});

test('T2.12 config: ARTICLE_FROM / ARTICLE_MONITORING_MARGIN_PCT が読める', () => {
  assert.equal(typeof fs.ARTICLE_FROM, 'string');
  assert.equal(fs.ARTICLE_MONITORING_MARGIN_PCT, 2);
});
