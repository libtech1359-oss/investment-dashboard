'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./helpers/publisherHarness');
const { publisher, setSheetsFixture, setAsk, setSaveDraft,
        setGeneratePortfolioChart, setGenerateFundHistoryChart,
        setRunEditorReview, setValidateArticle, resetValidateArticle } = harness;

const TEST_DATE = '2026-08-14';

// cash + pending + invested = total_assets（publish()冒頭の整合性チェックを満たす必要がある）。
// pfがnullだと円グラフ生成（generatePortfolioChart）自体が呼ばれず graphsGenerated が
// 常に1/2になってしまうため、chart系テストでは必ずこのfixtureを使う。
const PF_ROW = {
  cash: '5000000', total_assets: '10000000', invested: '5000000', pending: '0',
  unrealized_pl: '0', cash_ratio: '50.0', positions_json: '[]', pending_json: '[]',
};
const MKT_ROW = {
  fear_greed: 47, vix: 15.84, nasdaq100: 1.2, sp500: 0.5, sox: 0.1, gold: -0.2, usdjpy: 161.42,
};

function resetDefaults() {
  setSheetsFixture({ portfolioRow: PF_ROW, marketRow: MKT_ROW });
  setSaveDraft(async () => ({
    url: 'https://editor.note.com/notes/ok/edit/',
    historyEmbedded: true,
    chartEmbedded: true,
  }));
  setGeneratePortfolioChart(async () => '/fake/portfolio.png');
  setGenerateFundHistoryChart(async () => '/fake/history.png');
  setRunEditorReview(async () => ({ verdict: 'APPROVED', reasons: [], editorScore: 100, comment: '' }));
}

test('正常系: バリデーション初回PASS・グラフ2/2・埋め込み2/2 → 公開成功、再生成0回', async () => {
  resetDefaults();
  setValidateArticle(() => ({ ok: true, warnings: [] }));
  let askCalls = 0;
  setAsk(async () => { askCalls++; return `記事本文 v${askCalls}`; });

  const result = await publisher.publish(TEST_DATE);

  assert.equal(askCalls, 2, 'ask呼び出しは 記事生成1回 + X投稿1回 の計2回のはず');
  assert.equal(result.validationFailed, false);
  assert.equal(result.chartsIncomplete, false);
  assert.equal(result.graphsGenerated, 2);
  assert.equal(result.graphsEmbedded, 2);
  assert.ok(result.noteUrl);
  resetValidateArticle();
});

test('品質改善ループ1回: 1回目FAIL→2回目PASSで再生成1回のみ実行される', async () => {
  resetDefaults();
  let validateCalls = 0;
  setValidateArticle(() => {
    validateCalls++;
    return validateCalls === 1 ? { ok: false, warnings: ['❌ Rule 9\nダミー警告'] } : { ok: true, warnings: [] };
  });
  let askCalls = 0;
  setAsk(async () => { askCalls++; return `記事本文 v${askCalls}`; });

  const result = await publisher.publish(TEST_DATE);

  assert.equal(askCalls, 3, 'ask呼び出しは 初回生成 + 再生成1回 + X投稿1回 の計3回のはず');
  assert.equal(result.validationFailed, false);
  resetValidateArticle();
});

test('品質改善ループ上限到達: 常にFAILの場合、再生成は5回+AI編集長救済1回で打ち切られる（無限ループ禁止）', async () => {
  resetDefaults();
  setValidateArticle(() => ({ ok: false, warnings: ['❌ Rule 9\nダミー警告'] }));
  let askCalls = 0;
  setAsk(async () => { askCalls++; return `記事本文 v${askCalls}`; });

  const result = await publisher.publish(TEST_DATE);

  // 初回1回 + ループ内再生成5回 + AI編集長救済1回 = 7回で必ず打ち切られる
  assert.equal(askCalls, 7, `ask呼び出しは計7回で打ち切られるはず（実際: ${askCalls}回）`);
  assert.equal(result.validationFailed, true);
  assert.ok(result.fallbackDraftUrl, 'フォールバック下書きURLが保存されているべき');
  assert.match(result.note, /▼HISTORY▼/, 'フォールバック経路でも▼HISTORY▼マーカーが保証されるべき');
  assert.match(result.note, /▼CHART▼/, 'フォールバック経路でも▼CHART▼マーカーが保証されるべき');
  resetValidateArticle();
});

test('Ollamaタイムアウト等でLLM再生成が例外を投げても、処理全体を破棄せずfallback経路へ移行する', async () => {
  resetDefaults();
  setValidateArticle(() => ({ ok: false, warnings: ['❌ Rule 9\nダミー警告'] }));
  let askCalls = 0;
  setAsk(async () => {
    askCalls++;
    if (askCalls === 2) throw new Error('[ollama] タイムアウト（360秒応答なし）');
    return `記事本文 v${askCalls}`;
  });

  await assert.doesNotReject(() => publisher.publish(TEST_DATE), 'publish()全体が例外で落ちてはならない');

  // 初回(1) + 例外で即break(1回のみ、attempt2〜5は実行されない) + AI編集長救済(1) = 3回
  assert.equal(askCalls, 3, `再生成失敗後は即座にループを抜け、無駄なリトライをしないはず（実際: ${askCalls}回）`);
  resetValidateArticle();
});

test('グラフ生成1/2枚 → 公開停止（下書きのみ保存）', async () => {
  resetDefaults();
  setValidateArticle(() => ({ ok: true, warnings: [] }));
  setAsk(async () => '記事本文');
  setGeneratePortfolioChart(async () => '/fake/portfolio.png');
  setGenerateFundHistoryChart(async () => null); // 面グラフ生成失敗

  let savedBody = null;
  setSaveDraft(async ({ body }) => {
    savedBody = body;
    return { url: 'https://editor.note.com/notes/fallback/edit/', historyEmbedded: false, chartEmbedded: true };
  });

  const result = await publisher.publish(TEST_DATE);

  assert.equal(result.graphsGenerated, 1);
  assert.equal(result.graphsEmbedded, 0);
  assert.equal(result.validationFailed, true);
  assert.equal(result.chartsIncomplete, true);
  assert.ok(savedBody, 'グラフ不足でもフォールバック下書きが保存されるべき');
  assert.match(savedBody, /▼HISTORY▼/);
  assert.match(savedBody, /▼CHART▼/);
  resetValidateArticle();
});

test('グラフ生成2/2・埋め込み1/2 → 公開停止（validationFailed:true。従来はchartsIncompleteのみだった）', async () => {
  resetDefaults();
  setValidateArticle(() => ({ ok: true, warnings: [] }));
  setAsk(async () => '記事本文');
  setSaveDraft(async () => ({
    url: 'https://editor.note.com/notes/partial/edit/',
    historyEmbedded: true,
    chartEmbedded: false, // 円グラフの埋め込みのみ失敗
  }));

  const result = await publisher.publish(TEST_DATE);

  assert.equal(result.graphsGenerated, 2);
  assert.equal(result.graphsEmbedded, 1);
  assert.equal(result.validationFailed, true, '埋め込み1/2はvalidationFailed:trueであるべき（2026-08-14修正）');
  assert.equal(result.chartsIncomplete, true);
  assert.ok(result.noteUrl, '下書き自体は保存されているべき');
  resetValidateArticle();
});

test('グラフ生成2/2・埋め込み2/2 → 公開成功（X投稿文まで生成される）', async () => {
  resetDefaults();
  setValidateArticle(() => ({ ok: true, warnings: [] }));
  let askCalls = 0;
  setAsk(async () => { askCalls++; return askCalls === 1 ? '記事本文' : 'X投稿候補文'; });
  setSaveDraft(async () => ({
    url: 'https://editor.note.com/notes/full/edit/',
    historyEmbedded: true,
    chartEmbedded: true,
  }));

  const result = await publisher.publish(TEST_DATE);

  assert.equal(result.graphsGenerated, 2);
  assert.equal(result.graphsEmbedded, 2);
  assert.equal(result.validationFailed, false);
  assert.equal(result.chartsIncomplete, false);
  assert.ok(result.noteUrl);
  assert.equal(result.x, 'X投稿候補文');
  resetValidateArticle();
});
