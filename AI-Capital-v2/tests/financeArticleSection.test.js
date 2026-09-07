'use strict';

/**
 * financeArticleSection.test.js — 日刊記事への財前ミナ登場 Phase B
 *   - buildNoteSystemPrompt: activeCharacters に minae を含めた時だけ
 *     財前ミナのプロフィール＋💴財務戦略部セクション欄がプロンプトに入る／順序
 *   - computeActiveCharacters: financeShow フラグで minae を出し入れする
 *   - buildContext: financeCtx.show の時だけ【財務戦略部（財前ミナ）の状態】ブロックを積む
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildNoteSystemPrompt, ALL_CHARACTERS } = require('../lib/promptParts');
const sheets = require('../lib/sheets');
const pub    = require('../agents/publisher');

// ── B1: プロンプト組み立て ───────────────────────────────────
test('B1.1 ALL_CHARACTERS に minae が含まれる', () => {
  assert.ok(ALL_CHARACTERS.includes('minae'));
});

test('B1.2 activeCharacters に minae あり → プロフィールとセクション欄が入る', () => {
  const p = buildNoteSystemPrompt({ activeCharacters: ['shin', 'misaki', 'aoi', 'gai', 'rei', 'minae'] });
  assert.match(p, /財前ミナ（財務戦略部長）/);
  assert.match(p, /## 💴 財務戦略部（財前ミナ）/);
});

test('B1.3 activeCharacters に minae なし → 財前ミナは一切入らない', () => {
  const p = buildNoteSystemPrompt({ activeCharacters: ['shin', 'misaki', 'aoi', 'gai', 'rei'] });
  assert.doesNotMatch(p, /財前ミナ/);
  assert.doesNotMatch(p, /💴 財務戦略部/);
});

test('B1.4 セクション順: 審査部 → 財務戦略部 → 本日の論点 → 最終判断 → 秘書室長所見', () => {
  const p = buildNoteSystemPrompt({ activeCharacters: ['shin', 'misaki', 'aoi', 'gai', 'rei', 'minae'] });
  const iGai   = p.indexOf('【核心ルール】各部署の発言を審査し');
  const iMinae = p.indexOf('見出し直後の「状態：」「現金比率：」「提案：」「承認：」の各ラベル行');
  const iDisc  = p.indexOf('本日の会議全体で実際に議論になったテーマ・対立軸のみを1');
  const iRei   = p.indexOf('200〜350文字。相沢レイは会議の参加者ではなく');
  assert.ok(iGai > 0 && iMinae > iGai && iDisc > iMinae && iRei > iDisc,
    `順序不正: gai=${iGai} minae=${iMinae} disc=${iDisc} rei=${iRei}`);
});

// ── B2: computeActiveCharacters ─────────────────────────────
const recs4 = [
  { department: 'マーケット分析部' }, { department: 'リスク管理部' },
  { department: 'ポートフォリオ管理部' }, { department: '審査部' },
];

test('B2.1 財務非表示日 → minae は入らない（4部署 + rei）', () => {
  const chars = pub.computeActiveCharacters(recs4, false);
  assert.ok(!chars.includes('minae'));
  assert.ok(chars.includes('rei'));
});

test('B2.2 財務表示日 → minae が入る', () => {
  const chars = pub.computeActiveCharacters(recs4, true);
  assert.ok(chars.includes('minae'));
});

test('B2.3 recs 空・財務非表示 → ALL_CHARACTERS フォールバックでも minae を除去', () => {
  const chars = pub.computeActiveCharacters([], false);
  assert.ok(!chars.includes('minae'), 'recs空フォールバックに minae が残ってはいけない');
  assert.ok(chars.includes('shin') && chars.includes('rei'));
});

test('B2.4 recs 空・財務表示 → minae を追加', () => {
  const chars = pub.computeActiveCharacters([], true);
  assert.ok(chars.includes('minae'));
});

// ── B3: buildContext の財務戦略部ブロック ────────────────────
const origSheets = {
  getLatestRowAsOf: sheets.getLatestRowAsOf,
  getRowsByDate:    sheets.getRowsByDate,
};
test.beforeEach(() => {
  sheets.getLatestRowAsOf = async (name) => {
    if (name === 'portfolio_status') {
      return { total_assets: '10000000', cash: '1680000', pending: '0', invested: '8320000',
        cash_ratio: '16.8', positions_json: '[]', pending_json: '[]' };
    }
    return null; // market_data
  };
  sheets.getRowsByDate = async () => [];
});
test.afterEach(() => { Object.assign(sheets, origSheets); });

const DATE = '2026-09-08';

test('B3.1 financeCtx なし → 財務戦略部ブロックを積まない', async () => {
  const ctx = await pub.buildContext(DATE, [], [], [], null);
  assert.doesNotMatch(ctx, /財務戦略部（財前ミナ）の状態/);
});

test('B3.2 financeCtx.show=false → 積まない', async () => {
  const ctx = await pub.buildContext(DATE, [], [], [], { show: false, tone: 'monitoring', row: { mode: 'monitoring' } });
  assert.doesNotMatch(ctx, /財務戦略部（財前ミナ）の状態/);
});

test('B3.3 tone=monitoring → 状態=監視中・現金比率・発動ラインを含む', async () => {
  const row = { mode: 'monitoring', status: 'monitoring', cash_ratio_before: '16.8',
    reason: '現金比率は安全圏です。20%を下回った場合に利益確定・リバランスの検討を開始します。' };
  const ctx = await pub.buildContext(DATE, [], [], [], { show: true, tone: 'monitoring', row });
  assert.match(ctx, /財務戦略部（財前ミナ）の状態/);
  assert.match(ctx, /状態: 監視中/);
  assert.match(ctx, /現金比率: 16\.8%（発動ライン 20% \/ 監視解除 25%）/);
  assert.match(ctx, /断定的な売却予告はしない/);
});

test('B3.4 tone=proposal → 提案行・承認行（承認）を含む', async () => {
  const row = { mode: 'active', status: 'approved', cash_ratio_before: '15.0',
    asset_name: 'SOX', amount: '30000', gain_pct: '18.2',
    risk_review: 'APPROVE', audit_review: 'APPROVE', reason: 'x' };
  const ctx = await pub.buildContext(DATE, [], [], [], { show: true, tone: 'proposal', row });
  assert.match(ctx, /状態: 発動中/);
  assert.match(ctx, /提案: SOX を ¥30,000 部分利確（含み益\+18\.2%／取得原価の10%以内）/);
  assert.match(ctx, /承認: リスク管理部=APPROVE \/ 審査部=APPROVE → 承認/);
});

test('B3.5 tone=proposal・status=rejected → 承認行が「却下」', async () => {
  const row = { mode: 'active', status: 'rejected', cash_ratio_before: '15.0',
    asset_name: 'SOX', amount: '30000', gain_pct: '18.2', risk_review: 'APPROVE', audit_review: 'REJECT' };
  const ctx = await pub.buildContext(DATE, [], [], [], { show: true, tone: 'proposal', row });
  assert.match(ctx, /→ 却下/);
});

test('B3.6 tone=active（提案なし）→ 「提案: なし」を含む', async () => {
  const row = { mode: 'active', status: 'no_action', cash_ratio_before: '15.0',
    reason: '目標配分を超過し、かつ含み益・保有期間の条件を満たす銘柄がありませんでした' };
  const ctx = await pub.buildContext(DATE, [], [], [], { show: true, tone: 'active', row });
  assert.match(ctx, /状態: 発動中/);
  assert.match(ctx, /提案: なし（発動ラインは割ったが/);
});
