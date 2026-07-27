'use strict';

/**
 * changeClassifier.js — コード変更の自動分類（純粋関数・git/LLM非依存）
 *
 * scripts/auto-devlog.js から呼ばれる。git diffの「どのファイルが」「何を」
 * 変更したかという構造的な事実だけを根拠に分類する（決定的・高速・オフラインで動く
 * ことを優先し、Ollama等のLLM判定には依存しない — 無人運転中にLLMが落ちていても
 * ログ自体は必ず残る必要があるため）。
 *
 * 戻り値の type は development.MAJOR_EVENT_TYPES のキー、または 'OTHER'。
 * ルールは上から順に評価され、最初にマッチしたものを採用する。
 * どれにもマッチしない、または人間・AIエージェントの意図が読み取れない変更は
 * 全て 'OTHER' として記録される（＝分類ミスはあっても記録漏れは起きない）。
 */

// Weekly記事へ反映すべき「重大」判定の根拠となるコアファイル
const CORE_FILES = new Set([
  'lib/constitution.js',
  'lib/signalAggregator.js',
  'lib/articleValidator.js',
  'config/decisionWeights.js',
  'config/candidateScoreWeights.js',
  'config/targetAllocation.js',
  'config/financeStrategy.js',
]);

// ── diffTextから特定ファイルの追加/削除行だけを取り出す ──────────

function splitDiffByFile(diffText) {
  const map = {};
  if (!diffText) return map;
  const chunks = diffText.split(/^diff --git /m).filter(Boolean);
  for (const chunk of chunks) {
    const m = /^a\/(.+?) b\/(.+)$/m.exec(chunk);
    const file = m ? m[2].trim() : null;
    if (file) map[file] = chunk;
  }
  return map;
}

function linesFor(diffText, file, prefix) {
  const map   = splitDiffByFile(diffText);
  const chunk = map[file];
  if (!chunk) return '';
  const marker = prefix === '+' ? '+++' : '---';
  return chunk.split('\n')
    .filter(l => l.startsWith(prefix) && !l.startsWith(marker))
    .join('\n');
}

const addedLinesFor   = (diffText, file) => linesFor(diffText, file, '+');
const removedLinesFor = (diffText, file) => linesFor(diffText, file, '-');

// ── 分類ルール本体 ────────────────────────────────────────────

/**
 * @param {object} input
 * @param {string[]} input.files            - 変更ファイル（AI-Capital-v2からの相対パス）
 * @param {Object<string,string>} [input.fileStatus] - { file: 'A'|'M'|'D'|'R' }（git diff --name-status由来）
 * @param {string} [input.diffText]         - 対象ファイルに絞った unified diff
 * @param {string} [input.subject]          - コミットメッセージ1行目
 * @param {string} [input.body]             - コミットメッセージ本文
 * @returns {{ type: string, rule: string }}
 */
function classify({ files = [], fileStatus = {}, diffText = '', subject = '', body = '' }) {
  const msg = `${subject}\n${body}`;
  const has = name => files.includes(name);

  if (has('lib/constitution.js')) {
    return { type: 'PHILOSOPHY', rule: 'lib/constitution.js を変更' };
  }

  if (has('config/decisionWeights.js') || has('lib/signalAggregator.js')) {
    return { type: 'RULE_ENGINE', rule: '最終判断ロジック（decisionWeights.js / signalAggregator.js）を変更' };
  }

  if (has('config/targetAllocation.js')) {
    const added   = addedLinesFor(diffText, 'config/targetAllocation.js');
    const removed = removedLinesFor(diffText, 'config/targetAllocation.js');
    const keyOf   = text => [...text.matchAll(/^[+-]\s*['"]([^'"]+)['"]\s*:/gm)].map(m => m[1]);
    const newKeys = keyOf(added).filter(k => !keyOf(removed).includes(k));
    if (newKeys.length > 0) {
      return { type: 'NEW_ASSET', rule: `targetAllocation.js に新規銘柄キー追加: ${newKeys.join(', ')}` };
    }
    return { type: 'EVAL_LOGIC', rule: 'targetAllocation.js の配分比率を変更' };
  }

  if (has('config/candidateScoreWeights.js')) {
    return { type: 'EVAL_LOGIC', rule: 'candidateScoreWeights.js（総合評価スコアの重み）を変更' };
  }

  if (has('gas-deploy/gas-v2.gs')) {
    const added = addedLinesFor(diffText, 'gas-deploy/gas-v2.gs');
    if (/ASSET_MASTER_SEED/.test(diffText) && /^\+\s*\[/m.test(added)) {
      return { type: 'NEW_ASSET', rule: 'asset_master シードに銘柄行を追加' };
    }
  }

  if (has('lib/articleValidator.js')) {
    const added = addedLinesFor(diffText, 'lib/articleValidator.js');
    if (/^\+\s*(function\s+\w+|exports\.\w+\s*=|module\.exports\s*=)/m.test(added)) {
      return { type: 'VALIDATOR', rule: 'articleValidator.js に新規チェック関数を追加' };
    }
  }

  const newAgentFiles = files.filter(f => f.startsWith('agents/') && fileStatus[f] === 'A');
  if (newAgentFiles.length > 0) {
    return { type: 'NEW_DEPT', rule: `新規エージェントファイル追加: ${newAgentFiles.join(', ')}` };
  }

  const modifiedAgentFiles = files.filter(f => f.startsWith('agents/') && fileStatus[f] !== 'A');
  for (const f of modifiedAgentFiles) {
    const added = addedLinesFor(diffText, f);
    // 「名前・所属・絵文字」を持つ人格オブジェクト定義が新規追加された場合を新規AI社員とみなす
    if (/name:\s*['"][^'"]+['"][\s\S]{0,80}(dept|department|emoji):/m.test(added)) {
      return { type: 'NEW_STAFF', rule: `${f} に新しい人格定義（name/dept）を追加` };
    }
  }

  if (/バグ|不具合|エラー|誤|fix/i.test(msg)) {
    const touchesCore = files.some(f => CORE_FILES.has(f));
    if (touchesCore) {
      return { type: 'MAJOR_BUGFIX', rule: 'バグ修正キーワード + コアファイルへの変更' };
    }
  }

  if (files.length >= 2 && /再設計|刷新|全体最適化|新設計|大幅|移行|再構築/.test(msg)) {
    return { type: 'MAJOR_EVENT', rule: '複数ファイルにまたがる大規模変更（設計変更を示すキーワードを検出）' };
  }

  return { type: 'OTHER', rule: 'いずれのルールにも一致しなかった変更' };
}

module.exports = { classify, CORE_FILES, splitDiffByFile, addedLinesFor, removedLinesFor };
