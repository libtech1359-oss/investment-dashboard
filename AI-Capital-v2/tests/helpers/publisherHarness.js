'use strict';

/**
 * publisherHarness.js — agents/publisher.js を実ネットワーク・実ファイルI/Oなしで
 * テストするための共有ハーネス。
 *
 * publisher.js は一部の依存関数を require時に分割代入している（例:
 * `const { ask } = require('../lib/ollama')`）。分割代入は require 時点の関数参照を
 * 固定してしまうため、後から `mod.ask = fn` のように上書きしても publisher.js 側の
 * 呼び出しには反映されない。そのため、publisher.js を最初に require する「前」に
 * 間接参照ラッパーへ差し替え、以後は current*Impl を書き換えるだけで
 * テストごとに挙動を変えられるようにしている。
 *
 * fs.readdirSync は data/charts・data/thumbnails に限り空配列を返すよう保護する
 * （publish() 冒頭の pruneOldImages() が実データの画像を削除しないようにするため）。
 */

const path = require('path');
const fs   = require('fs');

const PROTECTED_DIRS = [
  path.resolve(__dirname, '../../data/charts'),
  path.resolve(__dirname, '../../data/thumbnails'),
];
const originalReaddirSync = fs.readdirSync;
fs.readdirSync = function guardedReaddirSync(dir, ...rest) {
  if (typeof dir === 'string' && PROTECTED_DIRS.includes(path.resolve(dir))) {
    return [];
  }
  return originalReaddirSync.call(fs, dir, ...rest);
};

const ollamaLib       = require('../../lib/ollama');
const noteDraftLib    = require('../../lib/noteDraft');
const chartGenLib     = require('../../lib/chartGenerator');
const editorReviewLib = require('../../lib/editorReview');
const failLogLib      = require('../../lib/failArticleLog');
const articleValidatorLib = require('../../lib/articleValidator');
const sheetsLib       = require('../../lib/sheets');
const thumbGenLib     = require('../../lib/thumbnailGenerator');
const developmentLib  = require('../../agents/development');

let currentAsk = async () => { throw new Error('[harness] ask 実装が未設定です'); };
let currentSaveDraft = async () => ({
  url: 'https://editor.note.com/notes/test-fallback/edit/',
  historyEmbedded: true,
  chartEmbedded: true,
});
let currentGeneratePortfolioChart   = async () => '/fake/portfolio.png';
let currentGenerateFundHistoryChart = async () => '/fake/history.png';
let currentRunEditorReview = async () => ({ verdict: 'APPROVED', reasons: [], editorScore: 100, comment: '' });
let currentAppendFailLog   = () => {};
let currentValidateArticle = null; // null の場合は本物の articleValidator.validateArticle を使う

ollamaLib.ask                          = (...args) => currentAsk(...args);
noteDraftLib.saveDraft                 = (...args) => currentSaveDraft(...args);
chartGenLib.generatePortfolioChart     = (...args) => currentGeneratePortfolioChart(...args);
chartGenLib.generateFundHistoryChart   = (...args) => currentGenerateFundHistoryChart(...args);
editorReviewLib.runEditorReview        = (...args) => currentRunEditorReview(...args);
failLogLib.appendFailLog               = (...args) => currentAppendFailLog(...args);

const realValidateArticle = articleValidatorLib.validateArticle;
articleValidatorLib.validateArticle = (...args) =>
  (currentValidateArticle ?? realValidateArticle)(...args);

// sheets / thumbGen / development は namespace 経由アクセスのため、通常の再代入で
// テストごとに差し替え可能（ラッパー不要）。既定値は「常に空・成功扱い」。
sheetsLib.getLatestRowAsOf = async () => null;
sheetsLib.getRowsByDate    = async () => [];
sheetsLib.getRows          = async () => [];
sheetsLib.getRowsByDateRange = async () => [];
sheetsLib.getLatestRow     = async () => null;
sheetsLib.appendRow        = async () => ({});
sheetsLib.upsertRow        = async () => ({});
sheetsLib.post             = async () => ({});
thumbGenLib.generate               = async () => '/fake/thumb.png';
developmentLib.saveDevelopmentLog  = async () => ({});

// ── publisher.js はここで初めて require する（上の差し替え完了後） ──────────
const publisher = require('../../agents/publisher');

function setSheetsFixture({
  marketRow = null,
  portfolioRow = null,
  candidates = [],
  decisions = [],
  votes = [],
  recs = [],
  orders = [],
  articleDecisionsCount = 0,
} = {}) {
  sheetsLib.getLatestRowAsOf = async (sheetName) => {
    if (sheetName === 'portfolio_status') return portfolioRow;
    if (sheetName === 'market_data') return marketRow;
    return null;
  };
  sheetsLib.getRowsByDate = async (sheetName) => {
    switch (sheetName) {
      case 'final_decisions': return decisions;
      case 'agent_votes': return votes;
      case 'agent_recommendations': return recs;
      case 'department_recommendations': return recs;
      case 'candidate_assets': return candidates;
      case 'orders': return orders;
      default: return [];
    }
  };
  sheetsLib.getRows = async (sheetName) => {
    if (sheetName === 'article_decisions') {
      return Array.from({ length: articleDecisionsCount }, () => ({ date: '2026-08-01' }));
    }
    if (sheetName === 'portfolio_status') return portfolioRow ? [portfolioRow] : [];
    return [];
  };
}

// デフォルトフィクスチャ（テストごとに setSheetsFixture() で上書き可）
setSheetsFixture();

module.exports = {
  publisher,
  setSheetsFixture,
  setAsk:                       fn => { currentAsk = fn; },
  setSaveDraft:                 fn => { currentSaveDraft = fn; },
  setGeneratePortfolioChart:    fn => { currentGeneratePortfolioChart = fn; },
  setGenerateFundHistoryChart:  fn => { currentGenerateFundHistoryChart = fn; },
  setRunEditorReview:           fn => { currentRunEditorReview = fn; },
  setValidateArticle:           fn => { currentValidateArticle = fn; },
  resetValidateArticle:         () => { currentValidateArticle = null; },
  sheetsLib, thumbGenLib, developmentLib,
};
