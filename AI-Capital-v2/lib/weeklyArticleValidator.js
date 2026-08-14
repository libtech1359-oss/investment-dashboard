'use strict';

/**
 * weeklyArticleValidator.js — 週刊記事専用 公開前整合性監査（Rule W01〜W16）
 *
 * 日刊の lib/articleValidator.js とは完全に独立したファイル。Rule番号は "Rule W01" の
 * ように "W" 接頭辞を付け、日刊のRule番号（数字のみ）・lib/qualityScorer.js の
 * RULE_CATEGORY・lib/qualityTracker.js の deriveChecks とは一切衝突しない。
 *
 * validateWeeklyArticle(note, facts, opts) を呼ぶと監査結果を返す。
 * ok === false の場合は公開（正式ドラフトとしての確定）をスキップすること。
 */

const { findDuplicateSentences } = require('./articleValidator');

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬'];

const NO_WINNER_TEXT = '今週は明確な勝者を設定できません';
const NO_DEBATE_TEXT = '今週は部署間で明確な意見対立が記録されませんでした';
const NO_GROWTH_TEXT = '今週は投資判断の仕組みにおいて特筆すべき変化はありませんでした';

function warn(ruleNum, title, ...pairs) {
  const lines = [`❌ Rule W${String(ruleNum).padStart(2, '0')}`, title];
  for (const [label, values] of pairs) {
    lines.push('');
    lines.push(label);
    for (const v of values) lines.push(v.startsWith('・') ? v : `・${v}`);
  }
  return lines.join('\n');
}

function extractCircledSection(note, circled) {
  const idx = CIRCLED.indexOf(circled);
  const startRe = new RegExp(`^${circled}[^\\n]*$`, 'm');
  const m = note.match(startRe);
  if (!m) return null;
  const start = note.indexOf(m[0]);
  const after = note.slice(start + m[0].length);
  // 次のいずれかの丸数字見出し行までを本文とみなす
  const nextRe = new RegExp(`\\n(?:${CIRCLED.join('|')})`);
  const nextIdx = after.search(nextRe);
  return (nextIdx >= 0 ? after.slice(0, nextIdx) : after).trim();
}

function numFrom(str) {
  return parseInt(String(str).replace(/,/g, ''), 10);
}

/**
 * @param {string} note   公開直前の記事全文（週刊専用クリーンアップ済み）
 * @param {object} facts  lib/weeklyFacts.buildWeeklyFacts() の返り値
 * @param {object} [opts]
 * @param {number} [opts.graphsGenerated]
 * @param {number} [opts.graphsEmbedded]
 * @returns {{ ok: boolean, warnings: string[] }}
 */
function validateWeeklyArticle(note, facts, opts = {}) {
  const warnings = [];
  const { graphsGenerated, graphsEmbedded } = opts;

  // ── Rule W01: 週次対象期間外の日付が記事に混入していないこと ──────────
  {
    const { start, end } = facts.period;
    const found = new Set();
    for (const m of note.matchAll(/\d{4}-\d{2}-\d{2}/g)) found.add(m[0]);
    for (const m of note.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})日/g)) {
      found.add(`${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`);
    }
    const outOfRange = [...found].filter(d => d < start || d > end);
    if (outOfRange.length > 0) {
      warnings.push(warn(1, '週次対象期間外の日付が記事に含まれています',
        ['対象期間', [`${start} 〜 ${end}`]],
        ['検出した期間外日付', outOfRange],
      ));
    }
  }

  // ── Rule W02: 投資回数と実データが一致すること（記事内の全出現箇所を確認） ──
  {
    const occurrences = [...note.matchAll(/投資回数[：:]\s*(\d+)\s*回/g)].map(m => numFrom(m[1]));
    if (occurrences.length === 0) {
      warnings.push(warn(2, '投資回数が記事内に見つかりません', ['実データ', [`${facts.investCount}回`]]));
    } else {
      const mismatched = occurrences.filter(v => v !== facts.investCount);
      if (mismatched.length > 0) {
        warnings.push(warn(2, '投資回数が実データと一致しません（記事内の複数箇所を確認）',
          ['実データ（final_decisions集計）', [`${facts.investCount}回`]],
          ['記事内で検出した値',              [...new Set(mismatched)].map(v => `${v}回`)],
        ));
      }
    }
  }

  // ── Rule W03: WAIT回数と実データが一致すること（記事内の全出現箇所を確認） ──
  {
    const occurrences = [...note.matchAll(/WAIT回数[：:]\s*(\d+)\s*回/g)].map(m => numFrom(m[1]));
    if (occurrences.length === 0) {
      warnings.push(warn(3, 'WAIT回数が記事内に見つかりません', ['実データ', [`${facts.waitCount}回`]]));
    } else {
      const mismatched = occurrences.filter(v => v !== facts.waitCount);
      if (mismatched.length > 0) {
        warnings.push(warn(3, 'WAIT回数が実データと一致しません（記事内の複数箇所を確認）',
          ['実データ（final_decisions集計）', [`${facts.waitCount}回`]],
          ['記事内で検出した値',              [...new Set(mismatched)].map(v => `${v}回`)],
        ));
      }
    }
  }

  // ── Rule W04: 総投資額と実データが一致すること ─────────────────────
  {
    const m = note.match(/総投資額[：:]\s*¥([\d,]+)/);
    if (!m) {
      warnings.push(warn(4, '総投資額が記事内に見つかりません', ['実データ', [`¥${facts.totalInvested.toLocaleString()}`]]));
    } else if (Math.abs(numFrom(m[1]) - facts.totalInvested) > 1000) {
      warnings.push(warn(4, '総投資額が実データ（ordersの実約定額合計）と一致しません',
        ['実データ（orders集計）', [`¥${facts.totalInvested.toLocaleString()}`]],
        ['記事内',                [`¥${numFrom(m[1]).toLocaleString()}`]],
      ));
    }
    if (!facts.investedAmountConsistent) {
      warnings.push(warn(4, 'final_decisionsの合計金額とordersの実約定合計が内部的に乖離しています（データ不整合の可能性）'));
    }
  }

  // ── Rule W05: ポートフォリオ前週比が実データと一致すること ──────────
  {
    const pc = facts.portfolioChange;
    const CHECKS = [
      { label: '総資産前週比',   re: /総資産前週比[：:]\s*(算出不可|[+\-]?[\d,]+)/,    key: 'totalDiff',        fmt: v => v.toLocaleString(), tol: 1000 },
      { label: '現金比率前週比', re: /現金比率前週比[：:]\s*(算出不可|[+\-]?[\d.]+)/,  key: 'cashRatioDiff',    fmt: v => v.toFixed(1),       tol: 0.15 },
      { label: '含み損益前週比', re: /含み損益前週比[：:]\s*(算出不可|[+\-]?[\d,]+)/,  key: 'unrealizedPlDiff', fmt: v => v.toLocaleString(), tol: 1000 },
      { label: '投資中資金前週比', re: /投資中資金前週比[：:]\s*(算出不可|[+\-]?[\d,]+)/, key: 'investedDiff',   fmt: v => v.toLocaleString(), tol: 1000 },
    ];
    for (const c of CHECKS) {
      const m = note.match(c.re);
      if (!m) continue; // Rule10相当の欠落チェックは対象外（machine生成セクションで別途保証）
      const artVal = m[1];
      if (!pc || !pc.computable) {
        if (artVal !== '算出不可') {
          warnings.push(warn(5, `${c.label}は前週データが無く算出不可のはずですが、記事内に数値が記載されています`,
            ['記事内', [artVal]],
          ));
        }
        continue;
      }
      if (artVal === '算出不可') {
        warnings.push(warn(5, `${c.label}は算出可能ですが、記事内で「算出不可」とされています`));
        continue;
      }
      const expected = pc[c.key];
      const artNum = parseFloat(artVal.replace(/,/g, '').replace(/^\+/, ''));
      if (Math.abs(artNum - expected) > c.tol) {
        warnings.push(warn(5, `${c.label}が実データと一致しません`,
          ['実データ（current - previous）', [c.fmt(expected)]],
          ['記事内',                          [artVal]],
        ));
      }
    }
  }

  // ── Rule W06: 市場データ平均値が実データと一致すること（記事内の同一指標の複数出現も含め整合） ──
  {
    const METRICS = [
      { label: 'Fear & Greed平均', re: /Fear\s*&\s*Greed平均[：:]\s*([\d.]+)/g, key: 'fear_greed', tol: 0.6 },
      { label: 'VIX平均',          re: /VIX平均[：:]\s*([\d.]+)/g,              key: 'vix',        tol: 0.6 },
      { label: 'USD\\/JPY平均',    re: /USD\/JPY平均[：:]\s*([\d.]+)/g,         key: 'usdjpy',     tol: 0.06 },
      { label: 'S&P500平均',       re: /S&P500平均[：:]\s*([\d.]+)/g,           key: 'sp500',      tol: 0.06 },
      { label: 'NASDAQ100平均',    re: /NASDAQ100平均[：:]\s*([\d.]+)/g,        key: 'nasdaq100',  tol: 0.06 },
    ];
    for (const metric of METRICS) {
      const stat = facts.marketStats[metric.key];
      const occurrences = [...note.matchAll(metric.re)].map(m => parseFloat(m[1]));
      if (occurrences.length === 0) continue;

      const uniqueVals = [...new Set(occurrences.map(v => v.toFixed(1)))];
      if (uniqueVals.length > 1) {
        warnings.push(warn(6, `${metric.label}が記事内で複数の異なる値として出現しています（表現の丸め方は統一すること）`,
          ['検出した値', uniqueVals],
        ));
      }
      if (stat) {
        const mismatched = occurrences.filter(v => Math.abs(v - stat.avg) > metric.tol);
        if (mismatched.length > 0) {
          warnings.push(warn(6, `${metric.label}が実データの平均値と一致しません`,
            ['実データ（market_data集計）', [`${stat.avg}`]],
            ['記事内',                      [...new Set(mismatched.map(String))]],
          ));
        }
      }
    }
  }

  // ── Rule W07: 勝者・敗者（反省点）の評価根拠が存在すること ──────────
  {
    const body = extractCircledSection(note, '⑤');
    if (body && !body.includes(NO_WINNER_TEXT)) {
      if (!facts.winnerLoserEligible) {
        warnings.push(warn(7, '勝者・反省点を選出できるだけの評価根拠が実データに無いにもかかわらず、記事内で選出しています',
          ['機械判定', [facts.winnerLoserIneligibleReason || '根拠不足']],
        ));
      }
    }
  }

  // ── Rule W08: 論争内容が実際の部署判断から構成されていること ────────
  {
    const body = extractCircledSection(note, '⑥');
    if (body && !body.includes(NO_DEBATE_TEXT)) {
      const dc = facts.debateCandidate;
      if (!dc) {
        warnings.push(warn(8, '論争として紹介できるだけの部署間対立が実データに存在しないにもかかわらず、記事内で論争を紹介しています'));
      } else {
        const mentionsDept  = dc.positions.some(p => body.includes(p.department));
        const mentionsAsset = dc.positions.some(p => p.asset_name !== 'なし' && body.includes(p.asset_name));
        if (!mentionsDept || !mentionsAsset) {
          warnings.push(warn(8, '論争セクションの内容が実データ（department_recommendations/final_decisions）の対立構図と対応していません',
            ['実データの対立日',   [dc.date]],
            ['実データの部署・銘柄', dc.positions.map(p => `${p.department} → ${p.action} ${p.asset_name}`)],
          ));
        }
      }
    }
  }

  // ── Rule W09: 引用Markdown（>）が残っていないこと ──────────────────
  {
    const lines = note.split('\n');
    const quoteLines = lines
      .map((l, i) => ({ lineNum: i + 1, text: l }))
      .filter(({ text }) => /^[ \t]*>/.test(text));
    if (quoteLines.length > 0) {
      warnings.push(warn(9, '引用Markdown（>）が記事内に残っています',
        ['行番号', quoteLines.slice(0, 5).map(({ lineNum, text }) => `行 ${lineNum}: ${text.trim().slice(0, 30)}`)],
      ));
    }
  }

  // ── Rule W10: Markdown装飾（*, **, ##, ---）が残っていないこと ──────
  // 先頭1個の # （H1・記事タイトル行）はnote.comのタイトル抽出に使われる正規の仕様のため対象外。
  {
    const found = [];
    if (/^#{2,6}[ \t]/m.test(note) || /^#{2,6}(?=[^\s#])/m.test(note)) found.push('##');
    if (/^-{3,}[ \t]*$/m.test(note)) found.push('---');
    if (/\*/.test(note)) found.push('*');
    if (found.length > 0) {
      warnings.push(warn(10, 'Markdown装飾が記事内に残っています', ['検出した記号', found]));
    }
  }

  // ── Rule W11: 同一見出し・同一市場データブロックの重複 ─────────────
  {
    const headingCounts = {};
    for (const c of CIRCLED) {
      const re = new RegExp(`^${c}[^\\n]*$`, 'gm');
      const count = (note.match(re) || []).length;
      if (count > 1) headingCounts[c] = count;
    }
    if (Object.keys(headingCounts).length > 0) {
      warnings.push(warn(11, '同一の章見出しが記事内に重複して出現しています',
        ['検出', Object.entries(headingCounts).map(([c, n]) => `${c}: ${n}回`)],
      ));
    }
    const dups = findDuplicateSentences(note.split('\n'));
    if (dups.length > 0) {
      const [text, count] = dups[0];
      warnings.push(warn(11, '同一の文・市場データブロックが記事内に重複して出現しています',
        ['重複内容', [text.slice(0, 80)]],
        ['出現回数', [`${count}回`]],
      ));
    }
  }

  // ── Rule W12: グラフ2枚が生成されていること ───────────────────────
  if (graphsGenerated !== undefined && graphsGenerated < 2) {
    warnings.push(warn(12, 'グラフが2枚生成されていません', ['生成枚数', [`${graphsGenerated} / 2`]]));
  }

  // ── Rule W13: グラフ2枚が記事本文に埋め込まれていること ────────────
  if (graphsEmbedded !== undefined && graphsEmbedded < 2) {
    warnings.push(warn(13, 'グラフが2枚とも記事本文に埋め込まれていません', ['埋め込み枚数', [`${graphsEmbedded} / 2`]]));
  }

  // ── Rule W14: graphsEmbedded < 2 の場合は公開禁止（W13と同一条件のハードゲート） ──
  if (graphsEmbedded !== undefined && graphsEmbedded < 2) {
    warnings.push(warn(14, 'グラフ埋め込みが2/2枚に達していないため公開できません（ハードゲート）'));
  }

  // ── Rule W15: AIの「学習」「成長」に関する記述に根拠が存在すること ──
  {
    const growthClaimRe = /(AIが学ん|学びを得|成長し(た|続け)|意識が高まった|視点が(強化|養わ)れた|投資判断の仕組みが賢くな)/;
    const hasClaim = growthClaimRe.test(note) && !note.includes(NO_GROWTH_TEXT);
    if (hasClaim && !facts.growthEvidence.hasEvidence) {
      const m = note.match(growthClaimRe);
      warnings.push(warn(15, 'AIの学習・成長に関する記述がありますが、根拠となる実データ（development_logs等）が存在しません',
        ['検出した記述', [m[0]]],
      ));
    }
  }

  // ── Rule W16: 「最大」「最重要」等の最上級表現に根拠が存在すること ──
  {
    const superlativeRe = /(今週最大|最重要|今週最悪|過去最高|過去最低)/g;
    const groundingKeywords = (facts.bigEventCandidates || [])
      .flatMap(c => [c.date, ...(c.description.match(/[一-龠ぁ-んァ-ヶA-Za-z0-9&]+/g) || [])])
      .filter(Boolean);
    for (const m of note.matchAll(superlativeRe)) {
      const idx = m.index;
      const ctx = note.slice(Math.max(0, idx - 40), idx + 120);
      const grounded = groundingKeywords.some(kw => kw.length >= 3 && ctx.includes(kw));
      if (!grounded) {
        warnings.push(warn(16, `最上級表現「${m[0]}」の近傍に、根拠となる実データ（機械抽出した候補）への言及が見当たりません`,
          ['本文抜粋', [ctx.replace(/\s+/g, ' ').slice(0, 150)]],
        ));
        break; // 1件検出すれば十分（同種の警告を大量に出さない）
      }
    }
  }

  return { ok: warnings.length === 0, warnings };
}

module.exports = { validateWeeklyArticle, extractCircledSection, NO_WINNER_TEXT, NO_DEBATE_TEXT, NO_GROWTH_TEXT };
