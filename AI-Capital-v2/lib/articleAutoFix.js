'use strict';

/**
 * articleAutoFix.js — Validatorが検出したレイアウト系警告を正規表現で機械修正する。
 *
 * LLM呼び出しは一切行わない（CPU推論コストゼロ・即時実行）。publisher.js の
 * 再生成ループは「①機械修正 → ②Validator再実行 → （それでも残る場合のみ）③LLM再生成」
 * の順で動くため、この関数は必ずLLM再生成より先に呼ばれる。
 *
 * 対応ルールは articleValidator.js の Rule 9 / 18 / 26 / 27 / 28 / 30 / 31 と対になっている
 * （内容の書き直しが必要な Rule 1〜7・12〜25 等はここでは扱わずLLM再生成に委ねる）。
 * 見出しパターン・許可絵文字は articleValidator.js の同名ルールと手動で同期させること。
 */

const HEADING_BLANK_SECTIONS = [
  { name: '今日の見どころ', patterns: [/📌[^\n]*今日の見どころ/, /今日の見どころ/] },
  { name: '今日の市場',     patterns: [/🌍[^\n]*今日の市場/, /今日の市場/] },
  { name: '本日の買付候補', patterns: [/🎯[^\n]*買付候補/, /本日の買付候補/] },
  { name: '各部署の判断',   patterns: [/🏢[^\n]*(?:部署|判断)/, /各部署の判断/] },
  { name: '最終判断',       patterns: [/⚖️[^\n]*最終判断/, /最終判断/] },
  { name: '次回の注目点',   patterns: [/👀[^\n]*注目点/, /次回の注目点/] },
  { name: '秘書室長所見',   patterns: [/👑[^\n]*秘書室長/, /秘書室長所見/] },
];

const ALLOWED_HEADING_EMOJI = new Set([
  '📊', '📋', '📌', '🌍', '🎯', '🏢', '⚖️', '🔴', '💰', '👀', '👑',
  '😎', '🤨', '🙂', '🧐', '😨', '📉', '⚠️', '💵',
]);

// ── Rule 09: Markdown見出し・横線の残留（安全網。通常は既存後処理⑰/⑰bで除去済み） ──
function fixMarkdownResiduals(note) {
  // # 1個（タイトル行のH1）は note.com のタイトル抽出に使われるため対象外とする
  // （articleValidator.js Rule 09 の検出条件 /^#{2,3}/ と揃える）。
  let out = note;
  let changed = false;
  if (/^#{2,6}[ \t]+/m.test(out)) { out = out.replace(/^#{2,6}[ \t]+/gm, ''); changed = true; }
  if (/^---[ \t]*$/m.test(out))   { out = out.replace(/^---[ \t]*$/gm, '');   changed = true; }
  return { note: out, changed };
}

// ── Rule 26: 箇条書き記号統一 ──────────────────────────────────
function fixBulletSymbols(note) {
  const re = /^([ \t]*)[\-\*•‣▪○●][ \t]+/gm;
  if (!re.test(note)) return { note, changed: false };
  return { note: note.replace(re, '$1・'), changed: true };
}

// ── Rule 27: 判断／信頼度／要約／推奨ラベルの改行崩れ ───────────
function fixLabelReflow(note) {
  const re = /([。」）])([ \t]*)(判断|信頼度|要約|推奨)([：:])/g;
  if (!re.test(note)) return { note, changed: false };
  return { note: note.replace(re, '$1\n$3$4'), changed: true };
}

// ── Rule 28: 意味の重複（同一文の行を後勝ちで除去） ─────────────
function fixDuplicateSentenceLines(note) {
  const lines = note.split('\n');
  const seen  = new Set();
  let changed = false;
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= 20 && /。$/.test(trimmed)) {
      if (seen.has(trimmed)) { changed = true; continue; }
      seen.add(trimmed);
    }
    out.push(line);
  }
  return { note: out.join('\n'), changed };
}

// ── Rule 30: 見出し直後の空行欠落 ──────────────────────────────
function fixHeadingBlankLine(note) {
  const lines = note.split('\n');
  let changed = false;
  for (const sec of HEADING_BLANK_SECTIONS) {
    let idx = -1;
    for (const pat of sec.patterns) {
      idx = lines.findIndex(l => pat.test(l));
      if (idx >= 0) break;
    }
    if (idx < 0) continue;
    if (lines[idx + 1] !== undefined && lines[idx + 1].trim() !== '') {
      lines.splice(idx + 1, 0, '');
      changed = true;
    }
  }
  return { note: lines.join('\n'), changed };
}

// ── Rule 31: 許可されていない見出し絵文字（絵文字のみ除去しテキストは残す） ──
function fixDisallowedHeadingEmoji(note) {
  let changed = false;
  const out = note.split('\n').map(line => {
    const trimmed = line.trim();
    const m = trimmed.match(/^(\p{Extended_Pictographic}️?)\s*(.*)$/u);
    if (!m) return line;
    const [, emoji, rest] = m;
    if (ALLOWED_HEADING_EMOJI.has(emoji)) return line;
    if (rest.length > 0 && rest.length <= 20 && !/[。、]/.test(rest)) {
      changed = true;
      return rest;
    }
    return line;
  });
  return { note: out.join('\n'), changed };
}

/**
 * @param {string} note
 * @returns {{ note: string, changed: boolean, fixesApplied: string[] }}
 */
function autoFixLayout(note) {
  let current = note;
  let anyChanged = false;
  const fixesApplied = [];

  const steps = [
    ['markdown_residual',  fixMarkdownResiduals],
    ['bullet_symbol',      fixBulletSymbols],
    ['label_reflow',       fixLabelReflow],
    ['duplicate_sentence', fixDuplicateSentenceLines],
    ['heading_blank_line', fixHeadingBlankLine],
    ['disallowed_emoji',   fixDisallowedHeadingEmoji],
  ];

  for (const [label, fn] of steps) {
    const result = fn(current);
    if (result.changed) {
      current = result.note;
      anyChanged = true;
      fixesApplied.push(label);
    }
  }

  current = current.replace(/\n{3,}/g, '\n\n');

  return { note: current, changed: anyChanged, fixesApplied };
}

module.exports = { autoFixLayout };
