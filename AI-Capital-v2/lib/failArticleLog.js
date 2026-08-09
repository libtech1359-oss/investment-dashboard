'use strict';

/**
 * failArticleLog.js — Validator/AI編集長で最終FAILとなった記事の診断ログ（Phase2.11）
 *
 * 目的：「FAILしたのに記事本文が残っておらず原因不明」という状態をなくす。
 * publisher.js の3つのFAIL出口（Validatorループ上限到達／AI編集長REJECT／
 * Quality Score基準未満）から呼び出され、記事全文と診断情報を
 * data/fail_articles.jsonl に1行1件のJSONLとして追記する。
 *
 * Validator本体（lib/articleValidator.js）の判定ロジックは一切変更していない。
 * Rule11・Rule28の診断抽出は、articleValidator.js が module.exports 経由で
 * 公開している extractSectionBody / findDuplicateSentences をそのまま再利用しており、
 * 判定ロジックの複製・分岐は行っていない（ロジックのズレが起きない設計）。
 */

const fs   = require('fs');
const path = require('path');
const { extractSectionBody, findDuplicateSentences } = require('./articleValidator');

const FAIL_LOG_FILE = path.join(__dirname, '..', 'data', 'fail_articles.jsonl');

// Rule11が対象とするセクション見出し（lib/articleValidator.js の RULE11_SECTIONS と同一の
// パターンを診断用に複製。RULE11_SECTIONS 自体は validateArticle() 内のローカル定数のため
// 直接importできない。見出し絵文字が変わった場合はこちらも合わせて更新すること）。
const RULE11_SECTIONS = [
  { name: '本日の論点',   patterns: [/🔴[^\n]*本日の論点/, /本日の論点/] },
  { name: '最終判断',     patterns: [/⚖️[^\n]*最終判断/, /最終判断/] },
  { name: '秘書室長所見', patterns: [/👑[^\n]*秘書室長/, /秘書室長所見/] },
];

/**
 * Rule11関連の警告がある場合、判定材料になった3セクション本文を抽出する。
 * @param {string} note
 * @returns {Object} セクション名 → 本文
 */
function extractRule11Diagnostics(note) {
  const sections = {};
  for (const sec of RULE11_SECTIONS) {
    sections[sec.name] = extractSectionBody(note, sec.patterns) || '（未検出）';
  }
  return sections;
}

/**
 * Rule28関連の警告がある場合、実際に検出された重複文をすべて抽出する
 * （articleValidator.js の findDuplicateSentences をそのまま呼ぶため、
 * Rule28が警告する内容と完全に一致する）。
 * @param {string} note
 * @returns {{text: string, count: number}[]}
 */
function extractRule28Diagnostics(note) {
  const noteLines = note.split('\n');
  return findDuplicateSentences(noteLines).map(([text, count]) => ({ text, count }));
}

/**
 * FAILした記事の全文・診断情報をJSONLへ1件追記する。
 *
 * @param {Object} entry
 * @param {string} entry.date
 * @param {string} [entry.articleId]
 * @param {string} [entry.finalSignal]
 * @param {string} [entry.finalAsset]
 * @param {string} entry.failStage - 'validator_loop_exhausted' | 'editor_rejected' | 'quality_score_below_threshold'
 * @param {string[]} [entry.ruleNums] - 発生したRule番号（例: ['11','28']）
 * @param {string[]} [entry.warnings] - Validatorのwarning本文
 * @param {number} [entry.mechanicalFixCount]
 * @param {number} [entry.regenerationCount]
 * @param {Object} [entry.editorReview] - runEditorReview() の戻り値（到達した場合のみ）
 * @param {string} entry.note - 記事全文
 */
function appendFailLog(entry) {
  const ruleNums = entry.ruleNums || [];
  const diagnostics = {};
  if (ruleNums.includes('11')) diagnostics.rule11 = extractRule11Diagnostics(entry.note);
  if (ruleNums.includes('28')) diagnostics.rule28 = extractRule28Diagnostics(entry.note);

  const record = {
    loggedAt:           new Date().toISOString(),
    date:                entry.date,
    articleId:           entry.articleId || '',
    finalSignal:         entry.finalSignal || '',
    finalAsset:          entry.finalAsset || '',
    failStage:           entry.failStage,
    ruleNums,
    warnings:            entry.warnings || [],
    mechanicalFixCount:  entry.mechanicalFixCount ?? null,
    regenerationCount:   entry.regenerationCount ?? null,
    editorReview:        entry.editorReview
      ? { verdict: entry.editorReview.verdict, editorScore: entry.editorReview.editorScore, reasons: entry.editorReview.reasons }
      : null,
    diagnostics,
    note: entry.note,
  };

  fs.mkdirSync(path.dirname(FAIL_LOG_FILE), { recursive: true });
  fs.appendFileSync(FAIL_LOG_FILE, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

function readAllFailLogs() {
  if (!fs.existsSync(FAIL_LOG_FILE)) return [];
  return fs.readFileSync(FAIL_LOG_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

module.exports = { appendFailLog, readAllFailLogs, extractRule11Diagnostics, extractRule28Diagnostics, FAIL_LOG_FILE };
