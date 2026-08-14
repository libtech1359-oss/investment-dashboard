'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const weeklyFacts = require('../lib/weeklyFacts');
const { validateWeeklyArticle, NO_WINNER_TEXT, NO_DEBATE_TEXT } = require('../lib/weeklyArticleValidator');
const { scoreWeeklyArticle, PUBLISH_SCORE_THRESHOLD_WEEKLY } = require('../lib/weeklyQualityScorer');
const { cleanupWeeklyForNote } = require('../lib/weeklyAutoFix');

function hasRuleW(warnings, ruleNum) {
  const padded = String(ruleNum).padStart(2, '0');
  return warnings.some(w => new RegExp(`Rule W${padded}\\b`).test(w));
}

// ── テストデータ生成ヘルパー ──────────────────────────────────

function buildSampleFacts(overrides = {}) {
  const market = [
    { date: '2026-08-04', fear_greed: '55', vix: '15.0', usdjpy: '148.00', sp500: '0.3', nasdaq100: '0.4' },
    { date: '2026-08-05', fear_greed: '50', vix: '16.0', usdjpy: '148.20', sp500: '-0.2', nasdaq100: '-0.3' },
    { date: '2026-08-06', fear_greed: '40', vix: '18.0', usdjpy: '148.50', sp500: '-1.0', nasdaq100: '-1.2' },
    { date: '2026-08-07', fear_greed: '35', vix: '20.0', usdjpy: '148.80', sp500: '0.5', nasdaq100: '0.6' },
    { date: '2026-08-08', fear_greed: '45', vix: '17.0', usdjpy: '149.00', sp500: '0.8', nasdaq100: '1.0' },
  ];

  const deptRecs = [
    { date: '2026-08-06', department: 'マーケット分析部',     action: 'ACCUMULATE', asset_name: 'NASDAQ100', recommended_amount: '100000', reason: 'Fear&Greedが40まで低下し押し目と判断' },
    { date: '2026-08-06', department: 'リスク管理部',         action: 'WAIT',       asset_name: 'なし',      recommended_amount: '0',      reason: 'VIXが18で警戒水準に近く様子見が妥当' },
    { date: '2026-08-06', department: 'ポートフォリオ管理部', action: 'ACCUMULATE', asset_name: 'NASDAQ100', recommended_amount: '100000', reason: '現金比率60%で余力があり分散投資として妥当' },
  ];

  const decisions = [
    { date: '2026-08-06', final_signal: 'ACCUMULATE', target_asset: 'NASDAQ100', amount: '100000', reason: 'Fear&Greed40・現金比率60%を踏まえ観測ポジションを構築' },
    { date: '2026-08-07', final_signal: 'WAIT',       target_asset: '',          amount: '0',      reason: 'VIX20で警戒水準のため様子見' },
  ];

  const orders = [
    { date: '2026-08-06', asset_name: 'NASDAQ100', amount: '100000', status: 'filled' },
  ];

  const portfolio = {
    date: '2026-08-08', total_assets: '10500000', cash: '4200000', cash_ratio: '40.0',
    unrealized_pl: '50000', pending: '0', invested: '6300000',
    positions_json: JSON.stringify([{ name: 'NASDAQ100', market_value: 6300000 }]),
  };
  const portfolioPrev = {
    date: '2026-08-01', total_assets: '10300000', cash: '4400000', cash_ratio: '42.7',
    unrealized_pl: '30000', pending: '0', invested: '6100000',
  };

  return weeklyFacts.buildWeeklyFacts({
    market,
    agentRecs: [],
    deptRecs,
    decisions,
    orders,
    portfolio,
    portfolioPrev,
    capitalEventsInWeek: [],
    majorEvents: [],
    startDate: '2026-08-04',
    endDate:   '2026-08-08',
    ...overrides,
  });
}

// ── weeklyFacts: 集計の正しさ ────────────────────────────────

test('weeklyFacts: 投資回数・WAIT回数・総投資額がfinal_decisions/ordersから正しく集計される', () => {
  const facts = buildSampleFacts();
  assert.equal(facts.investCount, 1);
  assert.equal(facts.accumulateCount, 1);
  assert.equal(facts.waitCount, 1);
  assert.equal(facts.totalInvested, 100000);
});

test('weeklyFacts: 売却注文(status=sold)は総投資額から除外される', () => {
  const facts = buildSampleFacts({
    orders: [
      { date: '2026-08-06', asset_name: 'NASDAQ100', amount: '100000', status: 'filled' },
      { date: '2026-08-07', asset_name: 'ゴールド',   amount: '80000',  status: 'sold' },
    ],
  });
  assert.equal(facts.totalInvested, 100000);
});

test('weeklyFacts: 市場データ平均値が単一の丸めルールで算出される', () => {
  const facts = buildSampleFacts();
  // fear_greed: (55+50+40+35+45)/5 = 45
  assert.equal(facts.marketStats.fear_greed.avg, 45);
  assert.equal(facts.marketStats.fear_greed.min, 35);
  assert.equal(facts.marketStats.fear_greed.max, 55);
});

test('weeklyFacts: ポートフォリオ前週比はcurrent-previousの機械計算のみ', () => {
  const facts = buildSampleFacts();
  assert.equal(facts.portfolioChange.computable, true);
  assert.equal(facts.portfolioChange.totalDiff, 200000);
  assert.equal(facts.portfolioChange.investedDiff, 200000);
});

test('weeklyFacts: 前週データが無い場合は算出不可とする', () => {
  const facts = buildSampleFacts({ portfolioPrev: null });
  assert.equal(facts.portfolioChange.computable, false);
});

test('weeklyFacts: 部署間で提案が割れた日を論争候補として抽出する', () => {
  const facts = buildSampleFacts();
  assert.ok(facts.debateCandidate);
  assert.equal(facts.debateCandidate.date, '2026-08-06');
});

test('weeklyFacts: 提案が割れた日が無ければ論争候補はnull', () => {
  const facts = buildSampleFacts({
    deptRecs: [
      { date: '2026-08-06', department: 'マーケット分析部', action: 'WAIT', asset_name: 'なし', recommended_amount: '0', reason: '様子見' },
      { date: '2026-08-06', department: 'リスク管理部',     action: 'WAIT', asset_name: 'なし', recommended_amount: '0', reason: '様子見' },
    ],
  });
  assert.equal(facts.debateCandidate, null);
});

test('weeklyFacts: 全部署の評価指標に差が無ければ勝者・反省点は選出不可', () => {
  const facts = buildSampleFacts({
    deptRecs: [
      { date: '2026-08-06', department: 'マーケット分析部', action: 'WAIT', asset_name: 'なし', recommended_amount: '0', reason: '様子見' },
      { date: '2026-08-06', department: 'リスク管理部',     action: 'WAIT', asset_name: 'なし', recommended_amount: '0', reason: '様子見' },
    ],
    decisions: [
      { date: '2026-08-06', final_signal: 'WAIT', target_asset: '', amount: '0', reason: '様子見' },
    ],
  });
  assert.equal(facts.winnerLoserEligible, false);
});

test('weeklyFacts: 今週最大の出来事は複数カテゴリの中から最大magnitudeが選ばれる', () => {
  const facts = buildSampleFacts();
  assert.ok(facts.biggestEvent);
  assert.ok(facts.bigEventCandidates.length > 1);
  assert.ok(facts.bigEventCandidates[0].magnitude >= facts.bigEventCandidates[1].magnitude);
});

// ── weeklyArticleValidator ────────────────────────────────────

function baseNote(facts, overrides = {}) {
  const lines = {
    header: `# 📊 AI Capital 週刊号　2026-W32（${facts.period.start}〜${facts.period.end}）`,
    topics: `② 今週のトピック\n\n・投資回数：${facts.investCount}回\n・WAIT回数：${facts.waitCount}回\n・Fear & Greed平均：45`,
    action: `④ AI Capitalの行動履歴\n\n総投資額：¥${facts.totalInvested.toLocaleString()}\n投資回数：${facts.investCount}回\nWAIT回数：${facts.waitCount}回`,
    winner: overrides.winner ?? `⑤ 今週の勝者・反省点\n\n${NO_WINNER_TEXT}。`,
    debate: overrides.debate ?? `⑥ 今週の論争\n\n${NO_DEBATE_TEXT}。`,
    portfolio: `⑦ ポートフォリオ変化\n\n総資産前週比：+200,000\n現金比率前週比：-2.7\n含み損益前週比：+20,000\n投資中資金前週比：+200,000`,
  };
  return Object.values({ ...lines, ...overrides.lines }).join('\n\n');
}

test('validateWeeklyArticle: 正常系の記事はPASSする', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts);
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.equal(result.ok, true, result.warnings.join('\n'));
});

test('Rule W01: 対象期間外の日付が混入していると検出する', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts) + '\n\n⑬ 次号予告\n\n・2099-01-01の市場動向に注目';
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 1));
});

test('Rule W02: 投資回数が実データと不一致だと検出する', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts, { lines: { action: `④ AI Capitalの行動履歴\n\n総投資額：¥${facts.totalInvested}\n投資回数：99回\nWAIT回数：${facts.waitCount}回` } });
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 2));
});

test('Rule W04: 総投資額が実データと不一致だと検出する', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts, { lines: { action: `④ AI Capitalの行動履歴\n\n総投資額：¥999,999,999\n投資回数：${facts.investCount}回\nWAIT回数：${facts.waitCount}回` } });
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 4));
});

test('Rule W05: 前週比が実データと不一致だと検出する', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts, { lines: { portfolio: `⑦ ポートフォリオ変化\n\n総資産前週比：+9,999,999\n現金比率前週比：-2.7\n含み損益前週比：+20,000\n投資中資金前週比：+200,000` } });
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 5));
});

test('Rule W05: 算出不可のはずが数値を記載していると検出する', () => {
  const facts = buildSampleFacts({ portfolioPrev: null });
  const note = baseNote(facts, { lines: { portfolio: `⑦ ポートフォリオ変化\n\n総資産前週比：+200,000\n現金比率前週比：-2.7\n含み損益前週比：+20,000\n投資中資金前週比：+200,000` } });
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 5));
});

test('Rule W06: 同一指標が記事内で異なる値として出現すると検出する（平均63.3 vs 平均63問題）', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts) + '\n\n③ 今週のマーケット振り返り\n\nFear & Greed平均：45.0\n\n② 再掲\n\nFear & Greed平均：46.0';
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 6));
});

test('Rule W07: 評価根拠が無いのに勝者を選出していると検出する', () => {
  const facts = buildSampleFacts({
    deptRecs: [
      { date: '2026-08-06', department: 'マーケット分析部', action: 'WAIT', asset_name: 'なし', recommended_amount: '0', reason: '様子見' },
      { date: '2026-08-06', department: 'リスク管理部',     action: 'WAIT', asset_name: 'なし', recommended_amount: '0', reason: '様子見' },
    ],
    decisions: [
      { date: '2026-08-06', final_signal: 'WAIT', target_asset: '', amount: '0', reason: '様子見' },
    ],
  });
  const note = baseNote(facts, { winner: '⑤ 今週の勝者・反省点\n\n🏆 今週の勝者\n神谷シン（マーケット分析部）\n\n理由\nよく頑張った。' });
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 7));
});

test('Rule W08: 論争候補が無いのに論争を紹介していると検出する', () => {
  const facts = buildSampleFacts({
    deptRecs: [
      { date: '2026-08-06', department: 'マーケット分析部', action: 'WAIT', asset_name: 'なし', recommended_amount: '0', reason: '様子見' },
    ],
  });
  const note = baseNote(facts, { debate: '⑥ 今週の論争\n\n神谷シンとアオイの間で激しい議論が交わされました。' });
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 8));
});

test('Rule W09: 引用Markdown（>）が残っていると検出する', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts) + '\n\n> 「これは引用です」';
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 9));
});

test('Rule W10: Markdown装飾（##,*,---）が残っていると検出する', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts) + '\n\n## 見出し\n\n**強調**テキスト\n\n---';
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 10));
});

test('Rule W10: 記事タイトル行の単一#は誤検知しない', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts);
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(!hasRuleW(result.warnings, 10));
});

test('Rule W11: 同一見出しが重複していると検出する', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts) + '\n\n② 今週のトピック\n\n・重複した見出しです';
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 11));
});

test('Rule W12/W14: グラフ生成・埋め込みが2枚未満だと検出する', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts);
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 1, graphsEmbedded: 1 });
  assert.ok(hasRuleW(result.warnings, 12));
  assert.ok(hasRuleW(result.warnings, 13));
  assert.ok(hasRuleW(result.warnings, 14));
});

test('Rule W15: 根拠のない「AIが学んだ」記述を検出する', () => {
  const facts = buildSampleFacts(); // majorEvents=[] → growthEvidence.hasEvidence=false
  const note = baseNote(facts) + '\n\n⑧ 今週確認された改善点\n\n今週AIは大きく成長した。市場心理をより深く理解できるようになったと学んだ。';
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 15));
});

test('Rule W16: 根拠のない最上級表現を検出する', () => {
  const facts = buildSampleFacts();
  const note = baseNote(facts) + '\n\n⑬ 次号予告\n\n・今週最大の転換点は投資哲学そのものでした。';
  const result = validateWeeklyArticle(note, facts, { graphsGenerated: 2, graphsEmbedded: 2 });
  assert.ok(hasRuleW(result.warnings, 16));
});

// ── weeklyQualityScorer ───────────────────────────────────────

test('scoreWeeklyArticle: 警告0件は100点でPUBLISH_SCORE_THRESHOLD_WEEKLYを満たす', () => {
  const score = scoreWeeklyArticle({ ok: true, warnings: [] });
  assert.equal(score.total, 100);
  assert.ok(score.total >= PUBLISH_SCORE_THRESHOLD_WEEKLY);
});

test('scoreWeeklyArticle: Rule番号の名前空間は日刊のRule番号と衝突しない', () => {
  const score = scoreWeeklyArticle({ ok: false, warnings: ['❌ Rule W02\nダミー'] });
  assert.ok(score.facts < 100); // W02はfactsカテゴリに分類される

  // "Rule 02"（日刊形式・Wなし）はRULE_CATEGORY_Wのどのカテゴリにも分類されない
  // （facts/narrative/layout/graphsは減点されない。validator総合指標のみ警告件数で減点される）
  const scoreDailyFormat = scoreWeeklyArticle({ ok: false, warnings: ['❌ Rule 02\nダミー（日刊形式）'] });
  assert.equal(scoreDailyFormat.facts, 100);
  assert.equal(scoreDailyFormat.narrative, 100);
  assert.equal(scoreDailyFormat.layout, 100);
  assert.equal(scoreDailyFormat.graphs, 100);
});

// ── weeklyAutoFix ─────────────────────────────────────────────

test('cleanupWeeklyForNote: #, ##, ---, **, *, > をすべて除去する', () => {
  const md = [
    '# タイトル行',
    '',
    '## 見出し',
    '**強調テキスト**',
    '* 箇条書き',
    '> 引用文',
    '---',
    '本文はそのまま残る',
  ].join('\n');
  const { note } = cleanupWeeklyForNote(md);
  assert.ok(!/^##/m.test(note));
  assert.ok(!/\*/.test(note));
  assert.ok(!/^>/m.test(note));
  assert.ok(!/^---$/m.test(note));
  assert.ok(note.includes('本文はそのまま残る'));
});

test('cleanupWeeklyForNote: 記事タイトル行の単一#はnote.comタイトル抽出のため保持する', () => {
  const md = '# 📊 AI Capital 週刊号\n\n本文';
  const { note } = cleanupWeeklyForNote(md);
  assert.ok(/^#\s+📊/.test(note));
});

test('cleanupWeeklyForNote: ▼HISTORY▼ / ▼CHART▼ マーカーは保持する', () => {
  const md = '本文1\n\n▼HISTORY▼\n\n本文2\n\n▼CHART▼\n\n本文3';
  const { note } = cleanupWeeklyForNote(md);
  assert.ok(note.includes('▼HISTORY▼'));
  assert.ok(note.includes('▼CHART▼'));
});

// ── 日刊への非影響 ────────────────────────────────────────────

test('日刊 lib/articleValidator.js / lib/qualityScorer.js は週刊モジュールと共存してもRule番号が衝突しない', () => {
  const { validateArticle } = require('../lib/articleValidator');
  const { scoreArticle, RULE_CATEGORY } = require('../lib/qualityScorer');
  const { RULE_CATEGORY_W } = require('../lib/weeklyQualityScorer');

  const dailyResult = validateArticle({
    note: '🌍 今日の市場\nテスト本文です。\n👑 秘書室長所見\n別のテスト本文です。',
    pf: null, candidates: [], decisions: [], recs: [], articleNum: 'AC-TEST-9999', date: '2026-08-14',
  });
  assert.equal(typeof dailyResult.ok, 'boolean');

  const dailyScore = scoreArticle(dailyResult);
  assert.equal(typeof dailyScore.total, 'number');

  // RULE_CATEGORY（日刊・数字キー）とRULE_CATEGORY_W（週刊・数字キーだがwarn()接頭辞が異なる）は
  // 別オブジェクトであり、互いのスコア計算に混入しないことを確認する。
  assert.notEqual(RULE_CATEGORY, RULE_CATEGORY_W);
});
