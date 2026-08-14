'use strict';

/**
 * weeklyAutoFix.js — 週刊記事専用のMarkdown/引用記号除去（機械処理・LLM呼び出しなし）
 *
 * 週刊記事は note.com のプレーンテキストエディタ上で読まれるため、Markdown記法
 * （# / ## / ### / --- / ** / * / >）を一切残してはならない（要件⑬）。
 * 日刊の lib/articleAutoFix.js とは完全に独立した週刊専用実装であり、
 * 日刊の見出しパターン・許可絵文字セットには一切依存しない。
 */

// ── ## / ### 見出し記号の除去（テキストは残す） ─────────────────
// 先頭1個の # （H1・記事タイトル行）は note.com のタイトル抽出（lib/noteDraft.js の
// extractTitle/extractBody）に使われるため対象外とする（日刊 lib/articleAutoFix.js の
// fixMarkdownResiduals と同じ方針：#{2,6} のみ除去）。
function stripHeadings(note) {
  const before = note;
  const out = note.replace(/^#{2,6}[ \t]+/gm, '').replace(/^#{2,6}(?=[^\s#])/gm, '');
  return { note: out, changed: out !== before };
}

// ── --- 横線の除去 ────────────────────────────────────────────
function stripHorizontalRule(note) {
  const before = note;
  const out = note.replace(/^-{3,}[ \t]*$/gm, '');
  return { note: out, changed: out !== before };
}

// ── > 引用記号の除去（テキストは通常の文章として残す） ──────────
function stripBlockquote(note) {
  const before = note;
  const out = note.replace(/^[ \t]*>+[ \t]*/gm, '');
  return { note: out, changed: out !== before };
}

// ── **強調** の除去（テキストは残す） ────────────────────────
function stripBold(note) {
  const before = note;
  const out = note.replace(/\*\*(.+?)\*\*/g, '$1');
  return { note: out, changed: out !== before };
}

// ── 行頭の "* " 箇条書き記号 → 「・」に統一 ───────────────────
function stripBulletAsterisk(note) {
  const before = note;
  const out = note.replace(/^([ \t]*)\*[ \t]+/gm, '$1・');
  return { note: out, changed: out !== before };
}

// ── 残った * （強調・装飾目的の孤立記号）を完全除去 ──────────────
function stripStrayAsterisk(note) {
  const before = note;
  const out = note.replace(/\*/g, '');
  return { note: out, changed: out !== before };
}

/**
 * @param {string} markdown
 * @returns {{ note: string, changed: boolean, fixesApplied: string[] }}
 */
function cleanupWeeklyForNote(markdown) {
  let current = markdown;
  let anyChanged = false;
  const fixesApplied = [];

  const steps = [
    ['blockquote',       stripBlockquote],
    ['heading',          stripHeadings],
    ['horizontal_rule',  stripHorizontalRule],
    ['bold',             stripBold],
    ['bullet_asterisk',  stripBulletAsterisk],
    ['stray_asterisk',   stripStrayAsterisk],
  ];

  for (const [label, fn] of steps) {
    const result = fn(current);
    if (result.changed) {
      current = result.note;
      anyChanged = true;
      fixesApplied.push(label);
    }
  }

  // ▼HISTORY▼ / ▼CHART▼ マーカーは画像挿入のため保持する（上記いずれの正規表現にも該当しない）
  current = current.replace(/\n{3,}/g, '\n\n').trim();

  return { note: current, changed: anyChanged, fixesApplied };
}

module.exports = {
  cleanupWeeklyForNote,
  stripHeadings,
  stripHorizontalRule,
  stripBlockquote,
  stripBold,
  stripBulletAsterisk,
  stripStrayAsterisk,
};
