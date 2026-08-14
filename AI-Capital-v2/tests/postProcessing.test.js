'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { applyPostProcessing } = require('../agents/publisher');

const MKT = {
  fear_greed: 47, vix: 15.84, nasdaq100: 1.2, sp500: 0.5, sox: 0.1, gold: -0.2, usdjpy: 161.42,
};

function baseCtx(overrides = {}) {
  return {
    date: '2026-08-14',
    articleNum: 'AC-2026-9999',
    recs: [],
    decisions: [],
    pf: null,
    mkt: MKT,
    ...overrides,
  };
}

const RAW_NOTE = `# 📊 AI Capital市場会議

## 📌 今日の見どころ
テスト用の見どころ本文です。

## 🌍 今日の市場
テスト用の市場解説です。数値は1.2%です。

## 🎯 本日の買付候補
テスト用の買付候補本文です。

## 🏢 各部署の判断

### マーケット分析部（神谷シン）
判断：観測ポジション構築推奨
信頼度：80%
要約：テスト用の要約本文です。

## ⚖️ 最終判断
テスト用の最終判断本文です。

## 💰 AI Capital模擬ファンド
総資産：¥10,000,000
現金残高：¥5,000,000

## 👀 次回の注目点
・テスト用の注目点です。

## 👑 秘書室長所見（相沢レイ）
テスト用の秘書室長所見本文です。

*AI Capitalは投資助言サービスではありません。AI社員による意思決定の記録を公開するプロジェクトです。投資判断はご自身の責任でお願いします。*
`;

test('applyPostProcessing: 通常の1回処理では Market Check ブロックは1回だけ挿入される', () => {
  const note = applyPostProcessing(RAW_NOTE, baseCtx());
  const count = (note.match(/📊 AI Capital Market Check/g) || []).length;
  assert.equal(count, 1, `期待: 1回, 実際: ${count}回`);
});

test('applyPostProcessing: 品質改善ループを模した2回目の処理でも Market Check ブロックは重複しない（Rule28再発防止）', () => {
  // 品質改善ループはLLMに「前回生成した記事全文（＝後処理済み・Market Checkブロック挿入済み）」を
  // そのまま渡し、「内容を維持しつつ修正」と指示する。LLMがブロックを複製した raw 出力を
  // 想定し、後処理済みの note をそのまま再度 applyPostProcessing に通す。
  const note1 = applyPostProcessing(RAW_NOTE, baseCtx());
  const note2 = applyPostProcessing(note1, baseCtx()); // 2周目（regen相当）
  const note3 = applyPostProcessing(note2, baseCtx()); // 3周目（さらなるregen相当）

  for (const [i, note] of [note1, note2, note3].entries()) {
    const count = (note.match(/📊 AI Capital Market Check/g) || []).length;
    assert.equal(count, 1, `${i + 1}周目で期待: 1回, 実際: ${count}回`);
  }
});

test('applyPostProcessing: Market Check ブロックが既に3個混入した壊れたnoteでも1個に収束する', () => {
  const dup = applyPostProcessing(RAW_NOTE, baseCtx());
  // 本番の除去ロジック（publisher.js ⑨a）と同じ境界でブロック本体を抽出し、
  // それを複製して「3回挿入された壊れた状態」を人工的に再現する。
  const marketCheckRe = /#{0,2}\s*📊\s*AI Capital Market Check[\s\S]*?(?=\n#{0,2}\s*(?:📌|🌍|🎯|🏢|⚖️|🔴|💰|👀|👑)|$)/;
  const m = dup.match(marketCheckRe);
  assert.ok(m, '前提: RAW_NOTEの後処理結果にMarket Checkブロックが存在すること');
  const block = m[0];
  const tripled = dup.replace(marketCheckRe, `${block}\n\n${block}\n\n${block}`);

  const before = (tripled.match(/📊 AI Capital Market Check/g) || []).length;
  assert.ok(before >= 3, '前提: 人工的に複数のMarket Checkブロックが混入していること');

  const fixed = applyPostProcessing(tripled, baseCtx());
  const after = (fixed.match(/📊 AI Capital Market Check/g) || []).length;
  assert.equal(after, 1, `期待: 1回, 実際: ${after}回`);
});

test('applyPostProcessing: ▼HISTORY▼/▼CHART▼マーカーは常に1回だけ存在する', () => {
  const note1 = applyPostProcessing(RAW_NOTE, baseCtx());
  const note2 = applyPostProcessing(note1, baseCtx());
  for (const marker of ['▼HISTORY▼', '▼CHART▼']) {
    for (const [i, note] of [note1, note2].entries()) {
      const count = (note.match(new RegExp(marker.replace(/[▼]/g, '\\▼'), 'g')) || []).length;
      assert.equal(count, 1, `${marker} が${i + 1}周目で${count}回出現`);
    }
  }
});
