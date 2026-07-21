'use strict';

/**
 * articleValidator.js — 公開前記事整合性監査
 *
 * validateArticle(articleData) を呼ぶと監査結果を返す。
 * ok === false の場合は公開をスキップすること。
 *
 * @param {Object} articleData
 * @param {string} articleData.note        - 最終記事テキスト（後処理済み）
 * @param {Object} articleData.pf          - portfolio_status 最新行
 * @param {Array}  articleData.candidates  - candidate_assets 行配列
 * @param {Array}  articleData.decisions   - final_decisions 行配列
 * @param {Array}  articleData.recs        - agent_recommendations 行配列
 * @param {string} articleData.articleNum  - 記事番号 (AC-YYYY-NNNN)
 * @param {string} articleData.date        - 記事日付 (YYYY-MM-DD)
 * @returns {{ ok: boolean, warnings: string[] }}
 */
function validateArticle({ note, pf, candidates, decisions, recs, articleNum, date }) {
  const warnings = [];

  const decision    = decisions?.[0] ?? null;
  const finalSignal = decision?.final_signal ?? '';
  const finalAsset  = decision?.target_asset ?? 'なし';
  const finalAmount = parseInt(decision?.amount ?? 0);
  const isBuySignal = ['BUY', 'ACCUMULATE'].includes(finalSignal);

  // 最終判断銘柄は candidate_assets の短名（例: "SOX"）で入るため、部署推薦がフルネーム
  // （例: "iFreeNEXT 全世界半導体株インデックス"）で書かれていても一致するよう、
  // 対応する候補行のフルネームも含めて双方向の部分一致で照合する。
  const finalCandidate  = (candidates ?? []).find(c => c.asset_name === finalAsset);
  const finalAssetNames = [finalAsset, finalCandidate?.full_name].filter(Boolean);
  const matchesFinalAsset = text => finalAssetNames.some(name => text.includes(name) || name.includes(text));

  // ── Rule 01: 買付候補と最終判断の整合 ────────────────────────
  if (isBuySignal && finalAsset && finalAsset !== 'なし') {
    const candNames = (candidates ?? []).map(c => c.asset_name).filter(Boolean);
    if (candNames.length > 0 && !candNames.includes(finalAsset)) {
      warnings.push(warn(1, '最終判断銘柄が買付候補に存在しません',
        ['候補',    candNames],
        ['最終判断', [`・${finalAsset}`]],
      ));
    }
  }

  // ── Rule 02: 各部署推奨との整合 ──────────────────────────────
  if (isBuySignal && finalAsset && finalAsset !== 'なし') {
    const buyRecs = (recs ?? []).filter(r => {
      const t = r.recommendation_type || r.action || '';
      return ['BUY', 'ACCUMULATE'].includes(t) &&
             r.asset_name && r.asset_name !== 'なし';
    });
    if (buyRecs.length >= 3 && buyRecs.every(r => !matchesFinalAsset(r.asset_name))) {
      warnings.push(warn(2, '全部署推奨銘柄と最終判断が乖離しています',
        ['部署推奨', buyRecs.map(r => `${r.department} → ${r.asset_name}`)],
        ['最終判断', [`・${finalAsset}`]],
      ));
    }
  }

  // ── Rule 03: 注文中資金・注文中銘柄 ──────────────────────────
  if (pf) {
    const pfPending   = parseInt(pf.pending ?? 0);
    const pendingList = safeParseJson(pf.pending_json, []);

    const artPendingMatch = note.match(/注文中資金[：:]\s*¥([\d,]+)/);
    if (artPendingMatch) {
      const artPending = parseInt(artPendingMatch[1].replace(/,/g, ''));
      if (Math.abs(artPending - pfPending) > 100) {
        warnings.push(warn(3, '注文中資金が一致しません',
          ['portfolio_status', [`¥${pfPending.toLocaleString()}`]],
          ['記事',              [`¥${artPending.toLocaleString()}`]],
        ));
      }
    }

    for (const po of pendingList) {
      const name = po.name || po.asset_name;
      if (name && !note.includes(name)) {
        warnings.push(warn(3, '注文中銘柄が記事内に見つかりません',
          ['portfolio_status', [`・${name}`]],
          ['記事',              ['（未記載）']],
        ));
      }
    }
  }

  // ── Rule 04: 現金残高 ─────────────────────────────────────────
  if (pf) {
    const pfCash   = parseInt(pf.cash ?? 0);
    const pfTotal  = parseInt(pf.total_assets ?? 0);
    const pfPend   = parseInt(pf.pending ?? 0);
    const pfInvest = parseInt(pf.invested ?? 0);

    const artCashMatch = note.match(/現金残高[：:]\s*¥([\d,]+)/);
    if (artCashMatch) {
      const artCash = parseInt(artCashMatch[1].replace(/,/g, ''));
      if (Math.abs(artCash - pfCash) > 100) {
        warnings.push(warn(4, '現金残高が一致しません',
          ['portfolio_status', [`¥${pfCash.toLocaleString()}`]],
          ['記事',              [`¥${artCash.toLocaleString()}`]],
        ));
      }
    }

    if (pfTotal > 0 && Math.abs(pfCash + pfPend + pfInvest - pfTotal) > 1000) {
      const sum = pfCash + pfPend + pfInvest;
      warnings.push(warn(4, 'portfolio_status 内部不整合（cash + pending + invested ≠ total_assets）',
        ['cash + pending + invested', [`¥${sum.toLocaleString()}`]],
        ['total_assets',              [`¥${pfTotal.toLocaleString()}`]],
      ));
    }
  }

  // ── Rule 05: 現金比率 ─────────────────────────────────────────
  if (pf) {
    const pfCash  = parseInt(pf.cash ?? 0);
    const pfTotal = parseInt(pf.total_assets ?? 0);
    const pfRatio = parseFloat(pf.cash_ratio ?? 0);

    if (pfTotal > 0) {
      const calcRatio = Math.round(pfCash / pfTotal * 1000) / 10;

      if (Math.abs(calcRatio - pfRatio) > 1.0) {
        warnings.push(warn(5, '現金比率 portfolio_status 内部不整合',
          ['計算値（cash / total_assets）', [`${calcRatio.toFixed(1)}%`]],
          ['記録値（cash_ratio）',           [`${pfRatio.toFixed(1)}%`]],
        ));
      }

      const artRatioMatch = note.match(/現金比率[：:]\s*([\d.]+)%/);
      if (artRatioMatch) {
        const artRatio = parseFloat(artRatioMatch[1]);
        if (Math.abs(artRatio - pfRatio) > 1.0) {
          warnings.push(warn(5, '現金比率が一致しません',
            ['計算値', [`${calcRatio.toFixed(1)}%`]],
            ['記事',   [`${artRatio.toFixed(1)}%`]],
          ));
        }
      }
    }
  }

  // ── Rule 06: 保有銘柄 ─────────────────────────────────────────
  if (pf) {
    const posList = safeParseJson(pf.positions_json, []);
    for (const pos of posList) {
      const name = pos.name || pos.asset_name;
      if (name && !note.includes(name)) {
        warnings.push(warn(6, '保有銘柄が記事内に見つかりません',
          ['portfolio_status', [`・${name}`]],
          ['記事',              ['（未記載）']],
        ));
      }
    }
  }

  // ── Rule 07: 投資金額 ─────────────────────────────────────────
  if (isBuySignal && finalAmount > 0) {
    const artAmtMatch = note.match(/買付金額[：:]\s*¥([\d,]+)/);
    if (artAmtMatch) {
      const artAmt = parseInt(artAmtMatch[1].replace(/,/g, ''));
      if (Math.abs(artAmt - finalAmount) > 1000) {
        warnings.push(warn(7, '買付金額が一致しません',
          ['final_decisions', [`¥${finalAmount.toLocaleString()}`]],
          ['記事',             [`¥${artAmt.toLocaleString()}`]],
        ));
      }
    }
  }

  // ── Rule 08: 重複チェック（AC番号・task_id・日付） ────────────
  if (articleNum) {
    const escaped   = articleNum.replace(/[-]/g, '\\-');
    const acMatches = (note.match(new RegExp(escaped, 'g')) ?? []).length;
    if (acMatches === 0) {
      warnings.push(warn(8, '記事番号が記事内に見つかりません',
        ['期待値',  [articleNum]],
        ['出現回数', ['0（最低1回必要）']],
      ));
    } else if (acMatches > 1) {
      warnings.push(warn(8, '記事番号が重複しています（1回のみが正常）',
        ['記事番号', [articleNum]],
        ['出現回数', [`${acMatches}回`]],
      ));
    }
  }

  if (/^🆔[^\n]*task-/m.test(note)) {
    const taskLine = note.split('\n').find(l => /^🆔[^\n]*task-/.test(l)) ?? '';
    warnings.push(warn(8, 'task_id が記事内に残っています（後処理⑧c で除去されるはず）',
      ['検出行', [taskLine.slice(0, 60)]],
    ));
  }

  if (date) {
    const dateJa      = date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1年$2月$3日');
    const dateMatches = (note.match(new RegExp(dateJa.replace(/[年月]/g, '(?:年|月)'), 'g')) ?? []).length;
    if (dateMatches > 3) {
      warnings.push(warn(8, '日付が多数出現しています（重複の可能性）',
        ['日付',    [dateJa]],
        ['出現回数', [`${dateMatches}回`]],
      ));
    }
  }

  // ── Rule 09: Markdown残留チェック ────────────────────────────
  const noteLines = note.split('\n');

  const mdHeaderLines = noteLines
    .map((l, i) => ({ lineNum: i + 1, text: l }))
    .filter(({ text }) => /^#{2,3}/.test(text));

  if (mdHeaderLines.length > 0) {
    const preview = mdHeaderLines.slice(0, 3).map(({ lineNum, text }) => `行 ${lineNum}: ${text}`);
    warnings.push(warn(9, 'Markdown見出しが残っています',
      ['検出',    [mdHeaderLines[0].text.match(/^#{2,3}/)[0]]],
      ['行番号',  preview],
    ));
  }

  const hrLines = noteLines
    .map((l, i) => ({ lineNum: i + 1, text: l }))
    .filter(({ text }) => /^---[ \t]*$/.test(text));

  if (hrLines.length > 0) {
    const preview = hrLines.slice(0, 3).map(({ lineNum }) => `行 ${lineNum}`);
    warnings.push(warn(9, '--- 横線が残っています',
      ['検出',  ['---']],
      ['行番号', preview],
    ));
  }

  // ── Rule 10: 空セクションチェック ────────────────────────────
  const SECTIONS = [
    { name: '今日の市場',       patterns: [/🌍[^\n]*今日の市場/, /今日の市場/] },
    { name: '買付候補',         patterns: [/🎯[^\n]*買付候補/, /本日の買付候補/] },
    { name: '部署判断',         patterns: [/🏢[^\n]*(?:部署|判断)/, /各部署の判断/] },
    { name: '最終判断',         patterns: [/⚖️[^\n]*最終判断/, /最終判断/] },
    { name: 'ポートフォリオ情報', patterns: [/💰[^\n]*AI Capital模擬ファンド/, /AI Capital模擬ファンド/] },
    { name: '次回の注目点',     patterns: [/👀[^\n]*注目点/, /次回の注目点/] },
    { name: '秘書室長所見',     patterns: [/👑[^\n]*秘書室長/, /秘書室長所見/] },
    { name: '免責事項',         patterns: [/AI Capitalは投資助言サービスではありません/] },
  ];

  for (const sec of SECTIONS) {
    let matchStr = null;
    for (const pat of sec.patterns) {
      const m = note.match(pat);
      if (m) { matchStr = m[0]; break; }
    }

    if (!matchStr) {
      warnings.push(warn(10, 'セクションが記事内に見つかりません',
        ['セクション', [sec.name]],
      ));
      continue;
    }

    // 次のメジャーセクション（主要絵文字）までを本文と見なす
    // 部署サブ絵文字（😎🤨🙂🧐）は 🏢セクション内に含まれるため区切りとしない
    const sectionStart = note.indexOf(matchStr);
    const afterHeader  = note.slice(sectionStart + matchStr.length);
    const nextIdx      = afterHeader.search(/\n(?:🌍|🎯|🏢|⚖️|👀|👑|💰|🎪)/);
    const body         = (nextIdx >= 0 ? afterHeader.slice(0, nextIdx) : afterHeader.slice(0, 300))
      .replace(/\s+/g, '')
      .trim();

    if (body.length < 10) {
      warnings.push(warn(10, 'セクションの内容が空または極端に短い',
        ['セクション', [sec.name]],
        ['文字数',      [`${body.length}文字（10文字未満）`]],
      ));
    }
  }

  // ── Rule 11: 結論系セクション（見どころ／論点／秘書室長所見）の銘柄整合性 ──
  // ── Rule 12: 部署合意状況の言及整合性 ─────────────────────────
  const SUMMARY_SECTIONS = [
    { name: '今日の見どころ', patterns: [/📌[^\n]*今日の見どころ/, /今日の見どころ/] },
    { name: '本日の論点',     patterns: [/🔴[^\n]*本日の論点/, /本日の論点/] },
    { name: '秘書室長所見',   patterns: [/👑[^\n]*秘書室長/, /秘書室長所見/] },
  ];
  const sectionBodies = {};
  for (const sec of SUMMARY_SECTIONS) {
    sectionBodies[sec.name] = extractSectionBody(note, sec.patterns);
  }

  if (isBuySignal && finalAsset && finalAsset !== 'なし') {
    const otherAssetNames = (candidates ?? [])
      .map(c => c.asset_name)
      .filter(name => name && name !== finalAsset);

    for (const sec of SUMMARY_SECTIONS) {
      const body = sectionBodies[sec.name];
      if (!body) continue;
      const mentionedOthers = otherAssetNames.filter(name => body.includes(name));
      if (mentionedOthers.length > 0 && !matchesFinalAsset(body)) {
        warnings.push(warn(11, `${sec.name}が最終判断銘柄と矛盾している可能性があります`,
          ['最終判断銘柄',   [`・${finalAsset}`]],
          ['検出した他銘柄', mentionedOthers],
          [`${sec.name}本文`, [body.slice(0, 120)]],
        ));
      }
    }
  }

  if (recs && recs.length >= 2) {
    const comboSet = new Set(recs.map(r => {
      const t = (r.recommendation_type || r.action || '').toUpperCase();
      const a = (t === 'WAIT' || !r.asset_name) ? 'なし' : r.asset_name;
      return `${t}:${a}`;
    }));
    const hasRealConsensus = comboSet.size <= 1;
    const hasRealConflict  = comboSet.size >= 2;
    const combinedText     = Object.values(sectionBodies).join('\n');

    if (/全部署一致|満場一致|全員一致|全社一致/.test(combinedText) && hasRealConflict) {
      warnings.push(warn(12, '「全部署一致」等の表現が実際の部署投票と矛盾しています',
        ['部署投票', recs.map(r => `${r.department} → ${r.recommendation_type || r.action}${r.asset_name && r.asset_name !== 'なし' ? ' ' + r.asset_name : ''}`)],
      ));
    }
    if (/意見が割れ|割れた|対立|賛否両論/.test(combinedText) && hasRealConsensus) {
      warnings.push(warn(12, '「意見が割れた」等の表現が実際の部署投票と矛盾しています',
        ['部署投票', recs.map(r => `${r.department} → ${r.recommendation_type || r.action}${r.asset_name && r.asset_name !== 'なし' ? ' ' + r.asset_name : ''}`)],
      ));
    }
  }

  return { ok: warnings.length === 0, warnings };
}

// ── ヘルパー ──────────────────────────────────────────────────

/**
 * 見出しパターンに一致するセクションの本文を抽出する（次のメジャーセクションまで）。
 * Rule 10 の空セクション判定と同じ境界ロジックを再利用する。
 */
function extractSectionBody(note, headerPatterns) {
  for (const pat of headerPatterns) {
    const m = note.match(pat);
    if (!m) continue;
    const start = note.indexOf(m[0]);
    const after = note.slice(start + m[0].length);
    const nextIdx = after.search(/\n(?:🌍|🎯|🏢|⚖️|👀|👑|💰|🎪)/);
    return (nextIdx >= 0 ? after.slice(0, nextIdx) : after.slice(0, 500)).trim();
  }
  return '';
}

/**
 * 監査警告メッセージを整形する。
 *
 * @param {number}   ruleNum - ルール番号（1〜10）
 * @param {string}   title   - 1行の問題説明
 * @param {...[string, string[]]} pairs - [ラベル, 値の配列] のペア
 * @returns {string}
 */
function warn(ruleNum, title, ...pairs) {
  const num   = String(ruleNum).padStart(2, '0');
  const lines = [`❌ Rule ${num}`, title];
  for (const [label, values] of pairs) {
    lines.push('');
    lines.push(label);
    for (const v of values) {
      lines.push(v.startsWith('・') || v.startsWith('行 ') ? v : `・${v}`);
    }
  }
  return lines.join('\n');
}

function safeParseJson(str, fallback) {
  try { return JSON.parse(str || '[]'); }
  catch { return fallback; }
}

module.exports = { validateArticle };
