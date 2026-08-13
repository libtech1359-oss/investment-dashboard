'use strict';

const { getDisplayCandidates } = require('./candidateGroups');

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
  // 「金額：」は⚖️最終判断セクションにシステムが機械挿入するラベル（injectRecommendationSummary）。
  // 「買付金額：」は旧・記事冒頭の結論ブロック（廃止済み）の名残りだが、互換のため両対応する。
  if (isBuySignal && finalAmount > 0) {
    const artAmtMatch = note.match(/(?:買付金額|金額)[：:]\s*¥([\d,]+)/);
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

  // ── Rule 11: 最終判断と結論系セクションの論理整合性（2026-08-09再設計） ──
  // 旧設計は「🔴本日の論点／👑秘書室長所見に最終銘柄名の文字列が無い」ことを
  // そのままFAILにしていたが、Phase2.5の実データ検証で2/2件が「記事全体としては
  // 矛盾していないが、その段落だけを見ると銘柄名の文字列が無い」という誤検知だった
  // （文字列不一致であって論理矛盾ではない）。
  // 新設計ではA（存在確認）とB（論理整合性）を分離する：
  //   A: 最終判断資産は⚖️最終判断の自動挿入ブロック（対象：〇〇）で必ず記事内に
  //      現れるため、「特定セクションに書かれているか」は判定材料にしない。
  //      記事全文のどこにも無い（自動挿入ブロック欠落等の異常時のみ）を保険的に検知する。
  //   B: 結論系セクション（🔴論点／⚖️最終判断のLLM補足文／👑秘書室長所見）が、
  //      実際の最終判断と食い違う「明示的な主張」をしていないかを検出する：
  //      B-1) 他の候補が「採用された／選ばれた」と明言している（実際の最終判断と別銘柄）
  //      B-2) 「安定性・守り・分散を最優先」等の守り重視の主張をしているのに、
  //           実際に採用された銘柄がGrowthカテゴリ（攻めの資産）である
  //      B-3) 「成長性・攻めを最優先」等の攻め重視の主張をしているのに、
  //           実際に採用された銘柄がDefenseカテゴリ（守りの資産）である
  //      Coreカテゴリ（オルカン等の分散型インデックス）は攻め/守りいずれの文脈にも
  //      入りうるため、B-2/B-3の対象から除外し誤検知を避ける。
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
  // 結論系セクションのみを対象とする文字列（Rule 25等で使用）。各部署の個別セクション
  // （少数派の反対意見等、Rule27の仕様上意図的に様子見・見送り表現を含みうる）は含まない。
  const conclusionText = Object.values(sectionBodies).filter(Boolean).join('\n');

  // Rule11専用の対象セクション（Rule35/36が使うfinalDecisionBodyと同じ抽出だが、
  // SUMMARY_SECTIONS／conclusionText（Rule12・Rule25・Rule35・Rule36が参照）とは
  // 独立変数に保ち、他ルールの挙動には影響させない）。
  const RULE11_SECTIONS = [
    { name: '本日の論点',   patterns: [/🔴[^\n]*本日の論点/, /本日の論点/] },
    { name: '最終判断',     patterns: [/⚖️[^\n]*最終判断/, /最終判断/] },
    { name: '秘書室長所見', patterns: [/👑[^\n]*秘書室長/, /秘書室長所見/] },
  ];
  const rule11SectionBodies = {};
  for (const sec of RULE11_SECTIONS) {
    rule11SectionBodies[sec.name] = extractSectionBody(note, sec.patterns);
  }
  const rule11CombinedText = Object.values(rule11SectionBodies).filter(Boolean).join('\n');

  if (isBuySignal && finalAsset && finalAsset !== 'なし') {
    // A: 存在確認（保険）。⚖️最終判断の自動挿入ブロックで必ず現れるはずのため、
    // 記事全文のどこにも無い場合のみ警告する（自動挿入の欠落等の異常検知）。
    if (!matchesFinalAsset(note)) {
      warnings.push(warn(11, '最終判断銘柄が記事本文のどこにも記載されていません',
        ['最終判断銘柄', [`・${finalAsset}`]],
      ));
    }

    const otherAssetNames = (candidates ?? [])
      .map(c => c.asset_name)
      .filter(name => name && name !== finalAsset);

    // B-1: 他の候補が「採用/選択/決定/選定」されたと明言している（実際と異なる銘柄）
    for (const otherName of otherAssetNames) {
      const wrongDecisionRe = new RegExp(`${escapeRegExp(otherName)}[^\\n。]{0,10}を(採用|選択|決定|選定)`);
      const m = rule11CombinedText.match(wrongDecisionRe);
      if (m) {
        warnings.push(warn(11, `結論系セクションが実際と異なる銘柄（${otherName}）を採用したと記載しています`,
          ['最終判断銘柄', [`・${finalAsset}`]],
          ['検出した記述', [m[0]]],
        ));
      }
    }

    // B-2 / B-3: 守り/攻めの主張と、実際に採用された銘柄のカテゴリの矛盾
    const displayCandidates  = getDisplayCandidates(candidates ?? []);
    const finalDisplayEntry  = displayCandidates.find(c => c.asset_name === finalAsset);
    const finalCategory      = finalDisplayEntry?.category ?? null; // 'core' | 'growth' | 'defense'（Coreは判定対象外）

    const STABILITY_CLAIM_RE = /(安定性|守り|防御|リスク回避|分散)を(最優先|優先|重視)/;
    const GROWTH_CLAIM_RE    = /(成長性|攻め|モメンタム|積極性)を(最優先|優先|重視)/;

    if (finalCategory === 'growth') {
      const m = rule11CombinedText.match(STABILITY_CLAIM_RE);
      if (m) {
        warnings.push(warn(11, `結論系セクションが守り重視の判断だったと記載していますが、実際の採用銘柄は成長（Growth）カテゴリです`,
          ['最終判断銘柄', [`・${finalAsset}（Growthカテゴリ）`]],
          ['検出した記述', [m[0]]],
        ));
      }
    } else if (finalCategory === 'defense') {
      const m = rule11CombinedText.match(GROWTH_CLAIM_RE);
      if (m) {
        warnings.push(warn(11, `結論系セクションが攻め重視の判断だったと記載していますが、実際の採用銘柄は防御（Defense）カテゴリです`,
          ['最終判断銘柄', [`・${finalAsset}（Defenseカテゴリ）`]],
          ['検出した記述', [m[0]]],
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

    // 「全部署一致」等は文字通り"全部署が同じ判断"の場合のみ矛盾とみなす。
    // 「リスク管理部を除く全部署が」「残り全部署が」等、一部部署の例外を明示した
    // 全会一致表現（＝多数派＋少数派の要約）は正常な表現なので対象外とする。
    const UNANIMOUS_RE   = /全部署一致|満場一致|全員一致|全社一致|全部署が|全員が/;
    const QUALIFIER_RE   = /除く|除き|以外|のみ|残り|他は|他の部署/;
    const BUY_ACTION_RE  = /買い|ACCUMULATE|購入|買付|BUY/i;
    const WAIT_ACTION_RE = /WAIT|見送り|様子見|待機|静観/i;

    const actualTypes           = [...new Set(recs.map(r => (r.recommendation_type || r.action || '').toUpperCase()))];
    const actualIsBuyUnanimous  = hasRealConsensus && ['BUY', 'ACCUMULATE'].includes(actualTypes[0]);
    const actualIsWaitUnanimous = hasRealConsensus && actualTypes[0] === 'WAIT';

    // 「〜を除く」等の限定表現は同一文中で判定するため文単位に分割する
    const unanimousSentences = combinedText
      .split(/(?<=[。\n])/)
      .filter(s => UNANIMOUS_RE.test(s) && !QUALIFIER_RE.test(s));

    const unanimousMismatch = unanimousSentences.some(s => {
      if (hasRealConflict) return true; // 実際は部署間で判断が割れているのに全会一致を主張
      if (actualIsWaitUnanimous && BUY_ACTION_RE.test(s) && !WAIT_ACTION_RE.test(s)) return true; // 実際は全部署WAITなのに「買いで一致」
      if (actualIsBuyUnanimous && WAIT_ACTION_RE.test(s) && !BUY_ACTION_RE.test(s)) return true; // 実際は全部署買いなのに「見送りで一致」
      return false;
    });

    if (unanimousMismatch) {
      warnings.push(warn(12, '「全部署が」等の全会一致表現が実際の部署投票と矛盾しています',
        ['部署投票', recs.map(r => `${r.department} → ${r.recommendation_type || r.action}${r.asset_name && r.asset_name !== 'なし' ? ' ' + r.asset_name : ''}`)],
      ));
    }
    if (/意見が割れ|割れた|対立|賛否両論/.test(combinedText) && hasRealConsensus) {
      warnings.push(warn(12, '「意見が割れた」等の表現が実際の部署投票と矛盾しています',
        ['部署投票', recs.map(r => `${r.department} → ${r.recommendation_type || r.action}${r.asset_name && r.asset_name !== 'なし' ? ' ' + r.asset_name : ''}`)],
      ));
    }
  }

  if (/前回購入価格比/.test(note)) {
    warnings.push(warn(13, '「前回購入価格比」は算出ロジックが未整備のため記事へ出力禁止です',
      ['検出箇所', [note.slice(Math.max(0, note.indexOf('前回購入価格比') - 30), note.indexOf('前回購入価格比') + 30)]],
    ));
  }
  if (/集中投資率[^\n]{0,15}(不明|算出できません|わかりません)/.test(note)) {
    warnings.push(warn(13, '集中投資率を「不明」等として出力しています（コンテキストに数値があるはずです）'));
  }

  // ── Rule 14: 逆張り用語の誤用 ──────────────────────────────────
  if (/逆張りによる売却/.test(note)) {
    warnings.push(warn(14, '「逆張りによる売却」という禁止表現が使われています（逆張りは買い増しを意味する）'));
  }

  // ── Rule 15: 管理者個人情報の禁止語 ──────────────────────────
  const PERSONAL_INFO_TERMS = ['生活防衛資金', '個人NISA', '個人口座残高', '個人資産状況'];
  for (const term of PERSONAL_INFO_TERMS) {
    if (note.includes(term)) {
      warnings.push(warn(15, `管理者個人情報に該当する禁止語「${term}」が記事に含まれています`));
    }
  }

  // ── Rule 16: 内部シグナル英語の残留 ──────────────────────────
  const englishSignalMatch = note.match(/\b(WAIT|BUY|SELL|ACCUMULATE|DEFEND)\b/);
  if (englishSignalMatch) {
    warnings.push(warn(16, '内部シグナル英語がそのまま出力されています（日本語表現に変換すること）',
      ['検出語', [englishSignalMatch[0]]],
    ));
  }

  // ── Rule 17: 橘アオイの禁止表現 ──────────────────────────────
  if (/最終投資額は.{0,10}(決定|確定)/.test(note)) {
    warnings.push(warn(17, '「最終投資額は〜に決定」という禁止表現が使われています（銘柄選定・最終決定は相沢レイの役割）'));
  }

  // ── 部署本文抽出ヘルパー（Rule 18以降で使用） ─────────────────
  const DEPT_HEADERS = {
    shin:   { label: '神谷',   pattern: /😎[^\n]*マーケット分析部/ },
    misaki: { label: '黒崎',   pattern: /🤨[^\n]*リスク管理部/ },
    aoi:    { label: 'アオイ', pattern: /🙂[^\n]*ポートフォリオ管理部/ },
    gai:    { label: '鬼塚',   pattern: /🧐[^\n]*審査部/ },
  };
  function extractDeptBody(pattern) {
    const m = note.match(pattern);
    if (!m) return null;
    const start = note.indexOf(m[0]);
    const after = note.slice(start + m[0].length);
    const nextIdx = after.search(/\n(?:🌍|🎯|🏢|⚖️|👀|👑|💰|🎪|😎|🤨|🙂|🧐)/);
    return (nextIdx >= 0 ? after.slice(0, nextIdx) : after.slice(0, 500)).trim();
  }

  // department_recommendations/agent_recommendations の日本語部署名 → DEPT_HEADERS のキー
  const DEPT_KEY_BY_NAME = {
    'マーケット分析部':     'shin',
    'リスク管理部':         'misaki',
    'ポートフォリオ管理部': 'aoi',
    '審査部':               'gai',
  };
  const DEPT_FIRST_NAME_BY_NAME = {
    'マーケット分析部':     '神谷',
    'リスク管理部':         '黒崎',
    'ポートフォリオ管理部': 'アオイ',
    '審査部':               '鬼塚',
  };

  // ── Rule 18: 部署見出しの重複掲載 ────────────────────────────
  const DEPT_HEADER_GLOBAL = [
    ['マーケット分析部', /😎[^\n]*マーケット分析部/g],
    ['リスク管理部',     /🤨[^\n]*リスク管理部/g],
    ['ポートフォリオ管理部', /🙂[^\n]*ポートフォリオ管理部/g],
    ['審査部',           /🧐[^\n]*審査部/g],
  ];
  for (const [name, pat] of DEPT_HEADER_GLOBAL) {
    const count = (note.match(pat) ?? []).length;
    if (count > 1) {
      warnings.push(warn(18, `${name}の見出しが記事内に${count}回出現しています（1回のみが正常）`));
    }
  }

  // ── Rule 19: 秘書室長所見の部署名主語 ────────────────────────
  const reiBody = extractSectionBody(note, [/👑[^\n]*秘書室長/, /秘書室長所見/]);
  const reiSubjectMatch = reiBody && reiBody.match(/(神谷|黒崎|アオイ|橘|鬼塚)は/);
  if (reiSubjectMatch) {
    warnings.push(warn(19, '秘書室長所見に部署名・個人名を主語にした要約文が残っています',
      ['検出', [reiSubjectMatch[0]]],
    ));
  }

  // ── Rule 20: 鬼塚ガイの3部署コメント網羅 ─────────────────────
  // その日実際に登場した部署（recs）についてのみ、審査コメントが揃っているかを確認する。
  const activeRecDepts = new Set((recs ?? []).map(r => r.department));
  const gaiBody = extractDeptBody(DEPT_HEADERS.gai.pattern);
  if (gaiBody) {
    const missing = [];
    if (activeRecDepts.has('マーケット分析部') && !/神谷の/.test(gaiBody)) missing.push('神谷の〜については');
    if (activeRecDepts.has('リスク管理部') && !/黒崎の/.test(gaiBody)) missing.push('黒崎の〜については');
    if (activeRecDepts.has('ポートフォリオ管理部') && !/(アオイの|橘の)/.test(gaiBody)) missing.push('アオイの〜については');
    if (missing.length > 0) {
      warnings.push(warn(20, '鬼塚ガイの要約に、その日登場した部署への審査コメントが揃っていません',
        ['不足', missing],
      ));
    }
  }

  // ── Rule 21: 橘アオイの規定書き出し ──────────────────────────
  const aoiBody = extractDeptBody(DEPT_HEADERS.aoi.pattern);
  if (aoiBody) {
    const aoiSummaryMatch = aoiBody.match(/要約[：:]\s*([\s\S]*)/);
    if (aoiSummaryMatch && !/^AI Capital模擬ファンドは現在[\d.]+%現金状態です/.test(aoiSummaryMatch[1].trim())) {
      warnings.push(warn(21, '橘アオイの要約が規定の書き出し（「AI Capital模擬ファンドは現在○○%現金状態です」）で始まっていません'));
    }
  }

  // ── Rule 22: 集中投資率の誇張表現 ────────────────────────────
  // 低水準（<15%）の数値に対して「極めて高水準/危険/深刻」等の強い表現を使っていないか。
  const EXAGGERATION_WORDS = /極めて(高水準|危険|深刻|大きい)/;
  const misakiBody2 = extractDeptBody(DEPT_HEADERS.misaki.pattern);
  for (const [name, body] of [['黒崎ミサキ', misakiBody2], ['橘アオイ', aoiBody]]) {
    if (!body) continue;
    const concMatch = body.match(/集中投資率[^\d]{0,4}([\d.]+)%/);
    if (concMatch && parseFloat(concMatch[1]) < 15 && EXAGGERATION_WORDS.test(body)) {
      warnings.push(warn(22, `${name}の要約が低水準の集中投資率（${concMatch[1]}%）に対して誇張表現を使っています`,
        ['本文抜粋', [body.slice(0, 150)]],
      ));
    }
  }

  // ── Rule 23: 単一根拠による買付判断の禁止 ────────────────────
  // 「今日の市場」＋「本日の買付候補」の本文を対象に、買付理由が単一指標だけに依存していないかを確認する。
  if (isBuySignal) {
    const marketBody     = extractSectionBody(note, [/🌍[^\n]*今日の市場/, /今日の市場/]);
    const candidatesBody = extractSectionBody(note, [/🎯[^\n]*買付候補/, /本日の買付候補/]);
    const rationaleText  = `${marketBody}\n${candidatesBody}`;

    const EVIDENCE_CATEGORIES = {
      'Fear & Greed':  /Fear\s*&\s*Greed/i,
      'ATH乖離率':      /(ATH|高値)[^\n]{0,10}(下落|乖離|圏)|乖離率/,
      'Rule Engine':   /(規則エンジン|Rule\s*Engine|推奨第1候補|スコア|Rank\s*\d|順位)/i,
      '部署判断':      /(神谷|黒崎|アオイ|鬼塚|マーケット分析部|リスク管理部|ポートフォリオ管理部|審査部)/,
      'Portfolio状況': /(集中投資率|ポートフォリオ比率|保有|現金比率)/,
      'VIX':           /VIX/,
      '市場データ':    /(前日比|NASDAQ|SOX|S&P\s*500|ドル円|ゴールド|変化率|反発率)/i,
    };
    const matchedEvidence = Object.entries(EVIDENCE_CATEGORIES)
      .filter(([, re]) => re.test(rationaleText))
      .map(([name]) => name);

    if (rationaleText.trim().length > 0 && matchedEvidence.length < 2) {
      warnings.push(warn(23, '買付理由が単一の根拠にしか依存していません（最低2項目の根拠が必要）',
        ['検出した根拠', matchedEvidence.length ? matchedEvidence : ['（検出なし）']],
        ['対象本文',     [rationaleText.replace(/\s+/g, ' ').slice(0, 200)]],
      ));
    }
  }

  // ── Rule 24: 数値と文章の整合性チェック（誇張表現） ──────────
  // 実際の数値が低水準／通常範囲であるにもかかわらず、記事内で過度に強い評価表現が
  // 使われていないかを確認する（対象: 現金比率・VIX・Fear&Greed・ATH乖離率・ポートフォリオ比率等）。
  const STRONG_EXAGGERATION = /(暴落|崩壊的|壊滅的|パニック的|危機的|資金枯渇|極めて逼迫|深刻な資金不足|集中し過ぎ|非常に危険|著しく偏って|極めて(高水準|危険|深刻|大きい))/;

  // VIX: 20未満は「平穏／通常レンジ」（constitution/investmentPhilosophy.vixCriteria）
  const vixMatch = note.match(/VIX[：:]\s*([\d.]+)/);
  if (vixMatch && parseFloat(vixMatch[1]) < 20) {
    const idx = note.indexOf(vixMatch[0]);
    const ctx = note.slice(Math.max(0, idx - 100), idx + 300);
    if (STRONG_EXAGGERATION.test(ctx)) {
      warnings.push(warn(24, `VIXが${vixMatch[1]}（平穏〜通常レンジ）にもかかわらず、誇張した評価表現が近傍に使われています`,
        ['本文抜粋', [ctx.replace(/\s+/g, ' ').slice(0, 200)]],
      ));
    }
  }

  // Fear & Greed: スコアが「極端な恐怖」（0〜25）でない場合に、パニック的な表現を使っていないか
  const fgMatch = note.match(/Fear\s*&\s*Greed[：:]\s*([\d.]+)/);
  if (fgMatch && parseFloat(fgMatch[1]) > 25) {
    const idx = note.indexOf(fgMatch[0]);
    const ctx = note.slice(Math.max(0, idx - 60), idx + 300);
    if (/(パニック的|極端な恐怖状態|市場崩壊)/.test(ctx)) {
      warnings.push(warn(24, `Fear & Greedが${fgMatch[1]}（極端な恐怖ではない）にもかかわらず、パニック的な表現が使われています`,
        ['本文抜粋', [ctx.replace(/\s+/g, ' ').slice(0, 200)]],
      ));
    }
  }

  // 現金比率: 値が高いほど資金余力があるため、資金逼迫を示唆する表現とは矛盾する
  const cashRatioMatch = note.match(/現金比率[：:]\s*([\d.]+)%/);
  if (cashRatioMatch && parseFloat(cashRatioMatch[1]) >= 50) {
    const idx = note.indexOf(cashRatioMatch[0]);
    const ctx = note.slice(Math.max(0, idx - 100), idx + 300);
    if (/(資金枯渇|極めて逼迫|深刻な資金不足|資金が尽き)/.test(ctx)) {
      warnings.push(warn(24, `現金比率が${cashRatioMatch[1]}%（余力あり）にもかかわらず、資金逼迫を示唆する表現が使われています`,
        ['本文抜粋', [ctx.replace(/\s+/g, ' ').slice(0, 200)]],
      ));
    }
  }

  // ATH乖離率: 絶対値が小さい（高値圏に近い）のに「暴落・崩壊」等の表現
  for (const m of note.matchAll(/ATH乖離[^\d\-]{0,4}(-?[\d.]+)%/g)) {
    if (Math.abs(parseFloat(m[1])) < 3) {
      const ctx = note.slice(Math.max(0, m.index - 60), m.index + 200);
      if (/(暴落|崩壊的|壊滅的)/.test(ctx)) {
        warnings.push(warn(24, `ATH乖離率が${m[1]}%（高値圏に近い）にもかかわらず、暴落を示唆する表現が使われています`,
          ['本文抜粋', [ctx.replace(/\s+/g, ' ').slice(0, 200)]],
        ));
      }
    }
  }

  // ポートフォリオ比率: 集中投資率と同じ考え方（低水準の数値に誇張表現が付いていないか）。集中投資率自体は Rule 22 が担当。
  for (const m of note.matchAll(/ポートフォリオ比率[^\d]{0,4}([\d.]+)%/g)) {
    if (parseFloat(m[1]) < 15) {
      const ctx = note.slice(Math.max(0, m.index - 60), m.index + 200);
      if (STRONG_EXAGGERATION.test(ctx)) {
        warnings.push(warn(24, `ポートフォリオ比率が${m[1]}%（低水準）にもかかわらず、誇張した評価表現が使われています`,
          ['本文抜粋', [ctx.replace(/\s+/g, ' ').slice(0, 200)]],
        ));
      }
    }
  }

  // ── Rule 25: 最終判断との意味的整合性チェック ────────────────
  // 記事内の「様子見・見送り・保留」等の待機的表現と、「採用・買付を決定・観測ポジション構築」等の
  // 実行的表現が、最終判断（BUY/ACCUMULATE/観測ポジション構築 vs WAIT）と矛盾していないかを確認する。
  // 判定対象は結論系セクション（conclusionText＝今日の見どころ／本日の論点／秘書室長所見）のみに限定する。
  // note全文を対象にすると、少数派の反対意見（例: 審査部が個別セクションで「様子見支持」と表明する
  // ことはRule27の仕様上正常）まで矛盾として誤検知してしまうため（Rule12と同種の過検知バグ）。
  const WAIT_EXPRESSIONS   = /(様子見|買付を見送る|見送りとし|一旦保留|投資を控える|待機(?:とし|する|します|とします)|全社的に見送り)/;
  const EXECUTE_EXPRESSIONS = /(採用しました|採用します|買付を決定しました|買付を決定します|観測ポジションを構築します|観測ポジションを構築しました)/;

  const isWaitSignal = finalSignal === 'WAIT';

  if (isBuySignal) {
    const waitMatches = conclusionText.match(new RegExp(WAIT_EXPRESSIONS, 'g'));
    if (waitMatches && waitMatches.length > 0) {
      const idx = conclusionText.search(WAIT_EXPRESSIONS);
      const ctx = conclusionText.slice(Math.max(0, idx - 100), idx + 200);
      warnings.push(warn(25, `最終判断が${finalSignal}（買付実行）にもかかわらず、記事内に様子見・見送りを示す表現が含まれています`,
        ['検出表現', [...new Set(waitMatches)]],
        ['本文抜粋', [ctx.replace(/\s+/g, ' ').slice(0, 200)]],
      ));
    }
  }

  if (isWaitSignal) {
    const execMatches = conclusionText.match(new RegExp(EXECUTE_EXPRESSIONS, 'g'));
    if (execMatches && execMatches.length > 0) {
      const idx = conclusionText.search(EXECUTE_EXPRESSIONS);
      const ctx = conclusionText.slice(Math.max(0, idx - 100), idx + 200);
      warnings.push(warn(25, `最終判断がWAIT（見送り）にもかかわらず、記事内に買付・観測ポジション構築の実行を示す表現が含まれています`,
        ['検出表現', [...new Set(execMatches)]],
        ['本文抜粋', [ctx.replace(/\s+/g, ' ').slice(0, 200)]],
      ));
    }
  }

  // ── Rule 26: 箇条書き記号統一（・以外のマーカー残留） ─────────
  const strayBullets = noteLines
    .map((l, i) => ({ lineNum: i + 1, text: l }))
    .filter(({ text }) => /^[ \t]*[\-\*•‣▪○●][ \t]/.test(text));
  if (strayBullets.length > 0) {
    warnings.push(warn(26, '箇条書きに「・」以外の記号が残っています',
      ['検出', strayBullets.slice(0, 3).map(({ lineNum, text }) => `行 ${lineNum}: ${text.trim().slice(0, 30)}`)],
    ));
  }

  // ── Rule 27: 判断／信頼度／要約／推奨ラベルの改行崩れ ──────────
  // 前の文が句点・閉じ括弧で終わった直後にラベルが同一行で続いている＝改行が消失した典型パターン
  {
    const labelReflowRe = /[。」）][ \t]*(判断|信頼度|要約|推奨)[：:]/;
    const m = note.match(labelReflowRe);
    if (m) {
      const idx = note.indexOf(m[0]);
      const ctx = note.slice(Math.max(0, idx - 20), idx + 30).replace(/\n/g, '⏎');
      warnings.push(warn(27, `「${m[1]}：」の前で改行が消失し、前の文と同じ行に混在しています`,
        ['検出箇所', [ctx]],
      ));
    }
  }

  // ── Rule 28: 意味の重複（同一文の重複出現） ────────────────────
  {
    const dups = findDuplicateSentences(noteLines);
    if (dups.length > 0) {
      const [text, count] = dups[0];
      warnings.push(warn(28, '同一の文が記事内に重複して出現しています',
        ['重複文', [text.slice(0, 80)]],
        ['出現回数', [`${count}回`]],
      ));
    }
  }

  // ── Rule 29: 句読点不足（長文の句読点欠落） ────────────────────
  {
    const longRunOn = noteLines
      .map((l, i) => ({ lineNum: i + 1, text: l.trim() }))
      .find(({ text }) =>
        text.length > 120 &&
        !/[。、]/.test(text) &&
        !/^[^\s：:]{1,20}[：:]/.test(text)
      );
    if (longRunOn) {
      warnings.push(warn(29, '句読点のない長文（100文字超）が検出されました',
        ['行番号', [`行 ${longRunOn.lineNum}`]],
        ['内容',   [`${longRunOn.text.slice(0, 80)}...`]],
      ));
    }
  }

  // ── Rule 30: 見出し直後の空行欠落（見出し→空行→本文の形式） ────
  // 💰（データをそのまま転記・空行禁止）と🔴（箇条書きが見出し直下に密着する仕様）は
  // 意図的に空行なしの設計のため対象外とする。
  {
    const HEADING_BLANK_SECTIONS = [
      { name: '今日の見どころ', patterns: [/📌[^\n]*今日の見どころ/, /今日の見どころ/] },
      { name: '今日の市場',     patterns: [/🌍[^\n]*今日の市場/, /今日の市場/] },
      { name: '本日の買付候補', patterns: [/🎯[^\n]*買付候補/, /本日の買付候補/] },
      { name: '各部署の判断',   patterns: [/🏢[^\n]*(?:部署|判断)/, /各部署の判断/] },
      { name: '最終判断',       patterns: [/⚖️[^\n]*最終判断/, /最終判断/] },
      { name: '次回の注目点',   patterns: [/👀[^\n]*注目点/, /次回の注目点/] },
      { name: '秘書室長所見',   patterns: [/👑[^\n]*秘書室長/, /秘書室長所見/] },
    ];
    for (const sec of HEADING_BLANK_SECTIONS) {
      let headerLineIdx = -1;
      for (const pat of sec.patterns) {
        const idx = noteLines.findIndex(l => pat.test(l));
        if (idx >= 0) { headerLineIdx = idx; break; }
      }
      if (headerLineIdx < 0) continue; // 未検出はRule10が既に警告する

      const nextLine = noteLines[headerLineIdx + 1];
      if (nextLine !== undefined && nextLine.trim() !== '') {
        warnings.push(warn(30, '見出し直後に空行がなく、本文と密着しています',
          ['セクション', [sec.name]],
          ['直後の内容', [nextLine.slice(0, 40)]],
        ));
      }
    }
  }

  // ── Rule 31: 許可されていない見出し絵文字 ──────────────────────
  // 単独行で「絵文字＋短い見出し語」の形をしている行のみを対象とする（本文中の絵文字は対象外）。
  {
    const ALLOWED_HEADING_EMOJI = new Set([
      '📊', '📋', '📌', '🌍', '🎯', '🏢', '⚖️', '🔴', '💰', '👀', '👑',
      '😎', '🤨', '🙂', '🧐', '😨', '📉', '⚠️', '💵',
    ]);
    const headingLike = noteLines
      .map((l, i) => ({ lineNum: i + 1, text: l.trim() }))
      .filter(({ text }) => {
        const m = text.match(/^(\p{Extended_Pictographic}️?)\s*(.*)$/u);
        if (!m) return false;
        const [, emoji, rest] = m;
        if (ALLOWED_HEADING_EMOJI.has(emoji)) return false;
        return rest.length > 0 && rest.length <= 20 && !/[。、]/.test(rest);
      });
    if (headingLike.length > 0) {
      warnings.push(warn(31, '許可されていない絵文字が見出し形式で使われています',
        ['検出', headingLike.slice(0, 3).map(({ lineNum, text }) => `行 ${lineNum}: ${text.slice(0, 20)}`)],
      ));
    }
  }

  // ── Rule 32: 🎯本日の買付候補 の3カテゴリ欠落チェック ────────────
  // コンテキストに🥇Core/🚀Growth/🛡Defenseの候補が存在するのに、記事本文に
  // そのカテゴリの絵文字・銘柄名の両方が現れない場合、LLMが「理由が弱い」等の
  // 理由で候補行ごと省略している（記事のストーリー性を損なう既知の不具合）。
  {
    const candidatesBody = extractSectionBody(note, [/🎯[^\n]*買付候補/, /本日の買付候補/]);
    if (candidatesBody) {
      const displayCandidates = getDisplayCandidates(candidates ?? []);
      const CATEGORY_EMOJI = { core: '🥇', growth: '🚀', defense: '🛡' };
      const missing = displayCandidates
        .filter(c => {
          const emoji = CATEGORY_EMOJI[c.category];
          return !candidatesBody.includes(emoji) || !candidatesBody.includes(c.asset_name);
        })
        .map(c => `${c.label}（${c.asset_name}）`);
      if (missing.length > 0) {
        warnings.push(warn(32, '本日の買付候補で🥇Core/🚀Growth/🛡Defenseの一部カテゴリが欠落しています',
          ['欠落しているカテゴリ',   missing],
          ['コンテキスト上の候補',   displayCandidates.map(c => `${c.label}: ${c.asset_name}`)],
        ));
      }
    }
  }

  // ── Rule 33: 審査部の評価と結論の論理整合性 ────────────────────
  // 「〇〇は過大評価／根拠不足／論理破綻」のように他部署の主張を否定的に評価しながら、
  // 判断ラベルではその部署の提案をそのまま支持している場合、間に橋渡しの理由（それでも／ただし等）
  // がなければ論理が繋がっていない（結論へ至る理由の欠落）とみなす。
  {
    const gaiBody33 = extractDeptBody(DEPT_HEADERS.gai.pattern);
    if (gaiBody33) {
      const NEGATIVE_EVAL_RE = /(神谷|黒崎|アオイ|橘|鬼塚)の[^。\n]{0,20}(過大(?:評価)?|過小(?:評価)?|根拠不足|論理破綻|説得力に欠け|不十分|バイアス)/;
      const POSITIVE_LABEL_RE = /判断[：:][^\n]{0,10}(支持|推奨)/;
      // 「様子見支持」「慎重姿勢を支持」等は買付・積極提案への“積極支持”ではなく待機・慎重側の
      // 結論であり、否定評価と矛盾しない（Phase2.8修正：POSITIVE_LABEL_REが「支持」の文字列
      // だけで積極支持と誤認していたため分離）。判断ラベル周辺にこれらの語があれば対象外とする。
      const CAUTIOUS_LABEL_RE = /判断[：:][^\n]{0,10}(様子見|慎重姿勢|静観|待機|見送り)/;
      // 「ただし」等の逆接だけでなく、「そのため〜という形で」のように懸念を踏まえて
      // 実行方法（金額縮小・分散・積立化等）を調整した結果としての結論も橋渡しとみなす。
      // 「しかし」も同種の自然な逆接表現だが従来抜けていたため2026-08-09追加（Phase2.9で
      // 「神谷の主張は根拠不足。しかし、短期的な上昇余地はある。よって支持する」のような
      // 正当な橋渡し文をRule33が誤検知していたことが判明したため）。
      const BRIDGE_RE = /(ただし|とはいえ|それでも|一方で|なお|とはいうものの|であっても|とはいうもの|という形で|踏まえ|留意し|意識しつつ|縮小|限定的|しかし)/;
      const negMatch = gaiBody33.match(NEGATIVE_EVAL_RE);
      if (negMatch && POSITIVE_LABEL_RE.test(gaiBody33) && !CAUTIOUS_LABEL_RE.test(gaiBody33) && !BRIDGE_RE.test(gaiBody33)) {
        warnings.push(warn(33, '審査部が特定部署の主張を否定的に評価しながら、その評価と結論（支持／推奨）の間に理由の橋渡しがありません',
          ['検出した否定評価', [negMatch[0]]],
          ['審査部要約',       [gaiBody33.slice(0, 200)]],
        ));
      }
    }
  }

  // ── Rule 34: 今日の見どころでの結論（対象銘柄名）先出し禁止 ──────
  // 📌今日の見どころは⚖️最終判断より前に読まれる「論点提示」セクション。
  // 対立軸のみを書き、最終的に採用された銘柄名は書かない設計（詳細はhighlightsSectionテンプレート参照）。
  // 実際のLLM出力で「NASDAQ100への資金配分をどこまで進めるか」のように対象銘柄名を
  // 先出ししてしまうケースが確認されたため、機械チェックで検知する。
  if (finalAsset && finalAsset !== 'なし') {
    const highlightsBody = extractSectionBody(note, [/📌[^\n]*今日の見どころ/, /今日の見どころ/]);
    if (highlightsBody && matchesFinalAsset(highlightsBody)) {
      warnings.push(warn(34, '今日の見どころに最終判断の対象銘柄名が書かれており、結論を先出ししています',
        ['最終判断銘柄', [`・${finalAsset}`]],
        ['見どころ本文', [highlightsBody.slice(0, 150)]],
      ));
    }
  }

  // ── Rule 35: Rule Engine上位候補と最終採用銘柄の乖離説明（読者フィードバックより） ──
  // Rule Engineの総合評価が最も高い候補（rank=1）が実際には採用されなかった場合、
  // 「なぜRule Engine上位が採用されなかったのか」という視点が読者から寄せられている
  // （decisionTransparencyルール対応）。結論系セクション＋最終判断本文のいずれにも
  // 乖離を説明する記述が見当たらない場合、プロンプト指示が反映されていない可能性が
  // 高いとして警告する（LLM補正ループに乗せるための軽量ヒューリスティック）。
  {
    const rankedCandidates = (candidates ?? [])
      .filter(c => c.asset_name && c.rank !== undefined && c.rank !== null && c.rank !== '')
      .sort((a, b) => parseInt(a.rank) - parseInt(b.rank));
    const topCandidate = rankedCandidates[0];

    if (isBuySignal && topCandidate && finalAsset && finalAsset !== 'なし' &&
        parseInt(topCandidate.rank) === 1 && !matchesFinalAsset(topCandidate.asset_name)) {
      const finalDecisionBody = extractSectionBody(note, [/⚖️[^\n]*最終判断/, /最終判断/]);
      const targetText = `${conclusionText}\n${finalDecisionBody}`;
      const mentionsTopCandidate = targetText.includes(topCandidate.asset_name) ||
        (topCandidate.full_name && targetText.includes(topCandidate.full_name));
      const CONTRAST_RE = /(一方|しかし|ものの|とはいえ|それでも|見送|至らな|優先し|上回り|下回り|重視し|判断しました|根拠が不足|採用には至らな)/;
      if (!mentionsTopCandidate || !CONTRAST_RE.test(targetText)) {
        warnings.push(warn(35, 'Rule Engineの1位候補が最終採用されていませんが、記事内にその理由の説明が見当たりません',
          ['Rule Engine1位', [`・${topCandidate.asset_name}（スコア${topCandidate.score ?? '—'}）`]],
          ['最終判断銘柄',    [`・${finalAsset}`]],
        ));
      }
    }
  }

  // ── Rule 36: WAIT最終判断の見送り理由の具体性（読者フィードバックより） ────
  // 「見送りました」「様子見です」のような定型文だけで終わらせず、数値と理由の
  // 組み合わせで見送り理由を説明することを必須化する。
  {
    if (isWaitSignal) {
      const finalDecisionBody = extractSectionBody(note, [/⚖️[^\n]*最終判断/, /最終判断/]);
      const reasonText = (finalDecisionBody || conclusionText || '').trim();
      const trimmed = reasonText.replace(/\s+/g, '');
      if (trimmed) {
        const hasNumericEvidence = /\d/.test(reasonText);
        const hasReasonConnector = /(ため|により|ことから|と判断し|不足して|過熱|集中|警戒|優先し|乏しく|根拠)/.test(reasonText);
        const tooShort = trimmed.length < 15;
        if (tooShort || (!hasNumericEvidence && !hasReasonConnector)) {
          warnings.push(warn(36, '最終判断がWAIT（見送り）ですが、見送り理由に具体的な数値・根拠が示されていません',
            ['最終判断本文', [reasonText.slice(0, 150) || '（空）']],
          ));
        }
      }
    }
  }

  // ── Rule 37: 部署の「推奨：」行が実データ（department_recommendations等）と一致しているか ──
  // publisher.js の injectRecommendations() が機械挿入する「推奨：」行を検証する。LLMの自由記述
  // ではなくシステムが直接データから書いた行が対象のため、欠落・不一致＝機械挿入自体が失敗した
  // （部署見出し検出失敗等）ことを意味し、必ずFAILとする（2026-08-13の判断履歴トレーサビリティ
  // 断絶インシデントを受けて新設）。
  for (const r of (recs ?? [])) {
    const deptKey = DEPT_KEY_BY_NAME[r.department];
    if (!deptKey) continue;
    const body = extractDeptBody(DEPT_HEADERS[deptKey].pattern);
    if (!body) continue; // 見出し自体が無い場合はRule10/20が別途検知する

    const amt    = parseInt(r.amount ?? r.recommended_amount ?? 0);
    const action = (r.recommendation_type || r.action || 'WAIT').toUpperCase();
    const asset  = r.asset_name || 'なし';
    const isConcreteBuy = amt > 0 && asset !== 'なし' && !['WAIT', 'DEFEND'].includes(action);
    const expectedLine  = isConcreteBuy ? `${asset} ¥${amt.toLocaleString()}` : '今回は見送ります';

    const recMatch = body.match(/推奨[：:]\s*\n?([^\n]+)/);
    if (!recMatch) {
      warnings.push(warn(37, `${r.department}の「推奨：」行が記事内に見つかりません（機械挿入の失敗の可能性）`,
        ['実データ（department_recommendations）', [expectedLine]],
      ));
      continue;
    }
    const actualLine = recMatch[1].trim();
    if (actualLine !== expectedLine) {
      warnings.push(warn(37, `${r.department}の推奨内容が実データと一致しません`,
        ['実データ（department_recommendations）', [expectedLine]],
        ['記事内の推奨',                            [actualLine]],
      ));
    }
  }

  // ── Rule 38: 見送り部署の判断ラベルが買付方向の表現になっていないか ────────────
  // 以前は審査部のみ後処理⑩aで是正していたが、機械是正が失敗した場合の安全網として
  // 全部署を対象にブロッキングチェックする。
  {
    const BUY_LABEL_RE = /(構築推奨|買付推奨|積み増し推奨|打診買い推奨|構築を推奨|買付を推奨|買付準備中|段階的打診|買付検討)/;
    for (const r of (recs ?? [])) {
      const deptKey = DEPT_KEY_BY_NAME[r.department];
      if (!deptKey) continue;
      const action = (r.recommendation_type || r.action || 'WAIT').toUpperCase();
      if (!['WAIT', 'DEFEND'].includes(action)) continue;

      const body = extractDeptBody(DEPT_HEADERS[deptKey].pattern);
      if (!body) continue;
      const labelMatch = body.match(/判断[：:]\s*([^\n]+)/);
      if (labelMatch && BUY_LABEL_RE.test(labelMatch[1])) {
        warnings.push(warn(38, `${r.department}は見送り（${action}）ですが、判断ラベルが買付方向の表現になっています`,
          ['実データ',           ['見送り']],
          ['記事内の判断ラベル', [labelMatch[1].trim()]],
        ));
      }
    }
  }

  // ── Rule 39: 部署の要約が、自身の実際の推奨資産と異なる資産を提案として言及していないか ──
  // 例：神谷シンの実際の推奨はNASDAQ100なのに、要約文中で「S&P500を...提案します」のように
  // 別資産を自分の提案として書いてしまうLLMのハルシネーションを検知する
  // （2026-08-13の実インシデントより新設）。
  {
    const PROPOSE_VERB = '(提案します|提案する|推奨します|推奨する|積み増すことを提案|組み込むことを提案)';
    for (const r of (recs ?? [])) {
      const deptKey = DEPT_KEY_BY_NAME[r.department];
      if (!deptKey) continue;
      const asset = r.asset_name || 'なし';
      if (asset === 'なし') continue;

      const body = extractDeptBody(DEPT_HEADERS[deptKey].pattern);
      if (!body) continue;
      // 「推奨：」行（機械挿入・正しい）より前の自由記述部分のみを対象とする
      const summaryOnly = body.split(/推奨[：:]/)[0];

      const otherAssetNames = (candidates ?? [])
        .map(c => c.asset_name)
        .filter(name => name && name !== asset);

      for (const otherName of otherAssetNames) {
        const re = new RegExp(`${escapeRegExp(otherName)}[^。\\n]{0,15}${PROPOSE_VERB}`);
        const m = summaryOnly.match(re);
        if (m) {
          warnings.push(warn(39, `${r.department}の要約が、実際の推奨資産（${asset}）と異なる資産（${otherName}）を提案として記載しています`,
            ['実際の推奨資産（department_recommendations）', [asset]],
            ['検出した記述',                                  [m[0]]],
          ));
        }
      }
    }
  }

  // ── Rule 40: ⚖️最終判断の機械挿入ブロックがfinal_decisionsと一致しているか ────────
  // publisher.js の injectRecommendationSummary() が正しく実行されていれば必ず一致するはずだが、
  // 見出し検出失敗等で機械挿入自体がスキップされた場合を検知する安全網。
  if (decision) {
    const SIGNAL_JA_MAP = { BUY: '買付', ACCUMULATE: '観測ポジション構築', WAIT: '監視継続', DEFEND: '防御態勢', SELL: '売却' };
    const finalDecisionBody   = extractSectionBody(note, [/⚖️[^\n]*最終判断/, /最終判断/]);
    const expectedSignalLabel = SIGNAL_JA_MAP[finalSignal] || finalSignal;

    const sigMatch = finalDecisionBody.match(/シグナル[：:]\s*([^\n]+)/);
    if (!sigMatch || sigMatch[1].trim() !== expectedSignalLabel) {
      warnings.push(warn(40, '⚖️最終判断のシグナル表記がfinal_decisionsと一致しません（機械挿入の失敗の可能性）',
        ['final_decisions.final_signal', [`${finalSignal}（${expectedSignalLabel}）`]],
        ['記事内',                        [sigMatch ? sigMatch[1].trim() : '（未検出）']],
      ));
    }
    const assetMatch = finalDecisionBody.match(/対象[：:]\s*([^\n]+)/);
    if (!assetMatch || assetMatch[1].trim() !== finalAsset) {
      warnings.push(warn(40, '⚖️最終判断の対象銘柄表記がfinal_decisionsと一致しません（機械挿入の失敗の可能性）',
        ['final_decisions.target_asset', [finalAsset]],
        ['記事内',                        [assetMatch ? assetMatch[1].trim() : '（未検出）']],
      ));
    }
    const expectedAmtText = finalAmount > 0 ? `¥${finalAmount.toLocaleString()}` : 'なし';
    const amtMatch = finalDecisionBody.match(/金額[：:]\s*([^\n]+)/);
    if (!amtMatch || amtMatch[1].trim() !== expectedAmtText) {
      warnings.push(warn(40, '⚖️最終判断の金額表記がfinal_decisionsと一致しません（機械挿入の失敗の可能性）',
        ['final_decisions.amount', [expectedAmtText]],
        ['記事内',                  [amtMatch ? amtMatch[1].trim() : '（未検出）']],
      ));
    }
  }

  // ── Rule 41: 最終判断の採用経路（採用：行）が実データと矛盾していないか ────────────
  // 「誰の提案を採用したか」をLLMに推測させず機械判定した結果（injectRecommendationSummaryの
  // 採用：行）を検証する。買付シグナルなのに採用：行が無い、または実際に資産・金額が完全一致
  // する部署提案が存在するのにそれと異なる部署名が書かれている場合はFAILとする。
  if (isBuySignal && finalAsset && finalAsset !== 'なし') {
    const finalDecisionBody = extractSectionBody(note, [/⚖️[^\n]*最終判断/, /最終判断/]);
    const adoptMatch = finalDecisionBody.match(/採用[：:]\s*([^\n]+)/);
    if (!adoptMatch) {
      warnings.push(warn(41, '⚖️最終判断に採用経路（採用：行）が見つかりません（機械挿入の失敗の可能性）'));
    } else {
      const exactDeptMatch = (recs ?? []).find(r => {
        const rAmt    = parseInt(r.amount ?? r.recommended_amount ?? 0);
        const rAsset  = r.asset_name || 'なし';
        const rAction = (r.recommendation_type || r.action || 'WAIT').toUpperCase();
        return rAsset === finalAsset && rAmt === finalAmount && ['BUY', 'ACCUMULATE'].includes(rAction);
      });
      if (exactDeptMatch) {
        const expectedName = DEPT_FIRST_NAME_BY_NAME[exactDeptMatch.department];
        if (expectedName && !adoptMatch[1].includes(expectedName)) {
          warnings.push(warn(41, '採用経路の記載が、実際に完全一致する部署提案と異なります',
            ['実際に完全一致する部署', [`${exactDeptMatch.department}（${finalAsset} ¥${finalAmount.toLocaleString()}）`]],
            ['記事内の採用：行',       [adoptMatch[1].trim()]],
          ));
        }
      }
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
 * Rule 28 が使う重複文検出（行を「。」直後で文単位に分割し、trim後20文字以上・完全一致の
 * ものを重複としてカウントする）。診断ログ（lib/failArticleLog.js）からも同じロジックを
 * 再利用できるよう module.exports 経由で公開する（2026-08-09 Phase2.11・Rule28の判定
 * ロジック自体は変更していない、既存のインライン実装を関数として切り出しただけ）。
 *
 * @param {string[]} noteLines
 * @returns {[string, number][]} 重複していた文とその出現回数のペア配列（出現順）
 */
function findDuplicateSentences(noteLines) {
  const sentences = noteLines
    .flatMap(l => l.split(/(?<=。)/))
    .map(s => s.trim())
    .filter(s => s.length >= 20);
  const counts = new Map();
  for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()].filter(([, c]) => c >= 2);
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

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { validateArticle, extractSectionBody, findDuplicateSentences };
