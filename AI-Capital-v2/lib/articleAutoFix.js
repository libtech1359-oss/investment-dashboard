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

// ── Rule 28: 意味の重複（文単位で後勝ちの重複文だけを除去） ─────
// articleValidator.js の Rule 28 は行全体ではなく「行を文（。区切り）に分割した単位」で
// 重複を検出する（noteLines.flatMap(l => l.split(/(?<=。)/))）。旧実装は行全体が完全一致
// する場合しか除去できず、他の文と同じ行に同居する重複文（例:「文A。文B。」の文Aだけが
// 重複）を検出はできるが機械修正できていなかった（2026-08-09 Phase2.10で判明）。
// 本関数はRule 28と全く同じ境界・同じ「trim後の完全一致・20文字以上・句点で終わる」条件で
// 判定するため、Rule 28が警告を出す場合は必ず解消でき、Rule 28が警告しない微妙な表記ゆれ
// （句読点違い・空白違いなど完全一致しないもの）は誤って削除しない。
function fixDuplicateSentenceLines(note) {
  const lines = note.split('\n');
  const seen  = new Set();
  let changed = false;
  const out = [];
  for (const line of lines) {
    // Rule 28 と同じ境界（文末の「。」の直後）で行内の文を分割する。
    const parts = line.split(/(?<=。)/);
    let lineChanged = false;
    const kept = parts.filter(part => {
      const trimmed = part.trim();
      if (trimmed.length >= 20 && /。$/.test(trimmed)) {
        if (seen.has(trimmed)) { changed = true; lineChanged = true; return false; }
        seen.add(trimmed);
      }
      return true;
    });
    if (!lineChanged) {
      out.push(line);
      continue;
    }
    const rebuilt = kept.join('');
    // 行の中身が重複文だけだった場合は行ごと削除（従来の挙動を踏襲）。
    // 重複文以外の内容（他の文・前後の文言）が残る場合はその内容だけを残す。
    if (rebuilt.trim() !== '') out.push(rebuilt);
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
