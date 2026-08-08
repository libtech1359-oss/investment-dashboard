'use strict';

/**
 * risk.js — リスク管理部
 * 参照: market_data, positions
 * 出力: agent_votes への投票
 * 役割: 保守的なリスク評価。必ず何らかの警戒を表明する。
 */

const { ask }      = require('../lib/ollama');
const sheets       = require('../lib/sheets');
const constitution = require('../lib/constitution');
const { fgDisplay } = require('../lib/marketUtils');
const { getDisplayCandidates, isAllowedAssetName } = require('../lib/candidateGroups');

const DEPT       = 'リスク管理部';
const AGENT_NAME = '黒崎ミサキ';

const SYSTEM = `
あなたはAI Capital「リスク管理部」部長です。

【部署の役割】
市場リスク・ポジションリスク・集中リスクを評価してシグナルを投票する。
保守的で慎重。必ず何らかのリスクを指摘すること。
「問題なし」という結論は許可されない。

【入力データ】
- market_data: VIX・各指数変化率
- positions: 保有銘柄の時価データ（nav_prices から算出した確定基準価格ベース）
  columns: asset_name | market_value | unrealized_pl | ath_gap_pct | daily_change_pct
  ath_gap_pct が大きな負値 → ATHから大きく下落中（ドローダウンリスク）
- 本日の買付候補: 記事の「🥇Core候補/🚀Growth候補/🛡Defense候補」欄に表示されるのと
  完全に同じ3銘柄（各カテゴリの最上位1件）。マーケット分析部（神谷シン）はこの3件の中から提案する。

【候補銘柄の選択ルール（最重要・厳守）】
recommendationで銘柄に言及する場合、コンテキストに提示された「本日の買付候補」3件（Core/Growth/Defenseそれぞれの代表1件）に限る。
神谷シンの提案（他部署の投票が既にある場合はそれ）に対してリスク面から評価すること。コンテキストに存在しない銘柄を新たに提案することは絶対禁止。
特定の銘柄を推す必要がない場合はasset_nameを「なし」にしてよい（リスク管理部は銘柄選定が本分ではないため）。

【リスク判定基準（厳守）】
高リスク（DEFEND/SELL を検討）:
  - VIX >= 30
  - NASDAQ 前日比 <= -3% かつ VIX >= 25
  - 含み損が総資産の10%超
  - 特定銘柄への集中度 >= 60%

中リスク（WAIT を推奨）:
  - VIX 20-30
  - NASDAQ 前日比 -2〜-3%

低リスク（ACCUMULATE/BUY を許可）:
  - VIX < 20
  - 含み損が総資産の5%未満
  - 分散が十分（最大保有比率 < 40%）

【JSON出力スキーマ】
{
  "dept": "リスク管理部",
  "signal": "BUY|ACCUMULATE|WAIT|DEFEND|SELL",
  "confidence": <0-100の整数>,
  "risk_level": "HIGH|MEDIUM|LOW",
  "key_points": ["<リスク指摘1>", "<リスク指摘2>", "<リスク指摘3>"],
  "comment": "<100字以内。集中度・現金比率・保有銘柄数のいずれか具体的な数字を必ず1つ以上含めること（ATH乖離率はマーケット分析部の領域のため自身の主根拠にはしない）。「〜すべき」等、数字を伴わない号令だけで終わることは禁止。絵文字・Markdown禁止。>",
  "recommendation": {
    "asset_id": "<候補銘柄のasset_id。WAITの場合は空文字>",
    "asset_name": "<候補銘柄のshort_name。WAITの場合はなし>",
    "action": "ACCUMULATE|WAIT|DEFEND|SELL",
    "recommended_amount": <リスク評価後の推奨投資額（円整数）。WAITの場合は0>,
    "reason": "<30字以内。リスク根拠（VIX・想定損失など）>"
  }
}

【recommendation 記入ガイド】
- リスク管理部は「リスク評価後の上限額」を提示する部署
- HIGH: recommended_amount=0（WAIT/DEFEND） / MEDIUM: 200,000円以内 / LOW: 300,000〜500,000円
- リスクが高くても「少額なら許容」という形でACCUMULATEを選ぶことは可
- 候補銘柄はマーケット分析部の提案銘柄をそのまま使うことが多い

【数字で殴ること（最重要）】
comment は必ず集中度（特定銘柄の保有比率）・現金比率・保有銘柄数（分散状況）の
いずれか具体的な数字を使って締めること。ATH乖離率はマーケット分析部の領域のため、
自身の主根拠にはせず言及に留めること。「リスクがあるので慎重にすべき」のような数字なしの
号令だけで終わることは禁止。

【想定損失など金額の扱い】
comment・reason に「想定損失¥〇〇」のような金額を書く場合は、
「推奨額×想定下落率」のように算出根拠を示せる場合のみ書くこと（必須ではない）。
根拠を示せない当てずっぽうの金額は書かないこと。金額を書かない場合は上記の集中度・現金比率・
保有銘柄数のいずれかを必ず数字で示すこと。
`.trim();

function parseJson(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { dept: DEPT, signal: 'WAIT', confidence: 60, risk_level: 'MEDIUM', key_points: [], comment: 'JSON解析失敗' };
  try { return JSON.parse(m[0]); } catch {
    return { dept: DEPT, signal: 'WAIT', confidence: 60, risk_level: 'MEDIUM', key_points: [], comment: 'JSON解析失敗' };
  }
}

async function getTodayDisplayCandidates(date) {
  const candidatesRaw = await sheets.getRowsByDate('candidate_assets', date).catch(() => []);
  return getDisplayCandidates(candidatesRaw);
}

async function buildContext(date, displayCandidates) {
  // positions は portfolio_status.positions_json から取得（Single Source of Truth）
  const [mkt, pf, otherVotes] = await Promise.all([
    sheets.getLatestRow('market_data'),
    sheets.getLatestRow('portfolio_status').catch(() => null),
    sheets.getRowsByDate('agent_votes', date).catch(() => []),
  ]);
  const positions = JSON.parse(pf?.positions_json || '[]').map(p => ({
    asset_name:      p.name,
    market_value:    p.market_value,
    unrealized_pl:   p.unrealized_pl,
    ath_gap_pct:     p.ath_gap_pct,
    daily_change_pct: p.daily_change_pct,
  }));

  const lines = [];

  if (mkt) {
    lines.push('【市場リスク指標】');
    lines.push(`VIX: ${mkt.vix}（危機水準: >30）`);
    lines.push(`NASDAQ100前日比: ${mkt.nasdaq100}%（急落基準: <-3%）`);
    lines.push(`S&P500前日比: ${mkt.sp500}%`);
    lines.push(`SOX前日比: ${mkt.sox}%`);
    lines.push(`Fear & Greed: ${fgDisplay(mkt.fear_greed)}（恐怖: ≤45 極端な恐怖: ≤25）`);
  }

  if (positions.length > 0) {
    lines.push('');
    lines.push('【ポジションリスク】');
    let totalValue = 0;
    positions.forEach(p => { totalValue += parseFloat(p.market_value || 0); });
    positions.forEach(p => {
      const val     = parseFloat(p.market_value || 0);
      const conc    = totalValue > 0 ? (val / totalValue * 100).toFixed(1) : 0;
      const pl      = parseFloat(p.unrealized_pl || 0);
      const athStr  = p.ath_gap_pct && p.ath_gap_pct !== 'N/A' ? ` ATH乖離${p.ath_gap_pct}%` : '';
      const dchgStr = p.daily_change_pct && p.daily_change_pct !== 'N/A' ? ` 前日比${p.daily_change_pct}%` : '';
      lines.push(`・${p.asset_name}: 時価¥${Math.round(val).toLocaleString()} 集中度${conc}% 損益¥${Math.round(pl).toLocaleString()}${athStr}${dchgStr}`);
    });
    lines.push(`保有銘柄数: ${positions.length}銘柄  合計時価: ¥${Math.round(totalValue).toLocaleString()}`);
  } else {
    lines.push('【ポジション】なし（全額現金）');
  }

  if (displayCandidates.length > 0) {
    lines.push('');
    lines.push('【本日の買付候補（言及する場合はこの3件の中からのみ。ここに無い銘柄への言及は禁止）】');
    displayCandidates.forEach(c => lines.push(`${c.label}: ${c.asset_name} ATH乖離${c.ath_gap_pct}% 前日比${c.daily_change_pct}%`));
  }

  const marketVote = otherVotes.find(v => v.department === 'マーケット分析部');
  if (marketVote) {
    lines.push('');
    lines.push('【マーケット分析部（神谷シン）の提案（取得できた時点）】');
    lines.push(`signal=${marketVote.signal} 推奨銘柄: ${marketVote.recommendation_asset || 'なし'} ¥${(parseInt(marketVote.recommendation_amount || 0)).toLocaleString()}`);
  }

  return lines.join('\n');
}

async function analyze(date) {
  console.log(`[${DEPT}] 分析開始 ${date}`);

  try {
    const displayCandidates = await getTodayDisplayCandidates(date);
    const context = await buildContext(date, displayCandidates);
    const system  = constitution.prefix() + SYSTEM;

    const raw    = await ask(system, context, { num_predict: 1200 });
    const parsed = parseJson(raw);

    let signal        = parsed.signal ?? 'WAIT';
    const confidence   = parsed.confidence ?? 60;
    const comment      = (parsed.comment ?? '').slice(0, 200);

    // rec を先に確定（agent_votes と department_recommendations 両方で使用）
    let rec = parsed.recommendation ?? {};
    // 安全弁: LLMが「本日の買付候補」3件の外の銘柄を返した場合、記事の候補表示と
    // 部署議論が食い違わないよう安全側WAITに丸める（プロンプト指示だけに依存しない）
    if (!isAllowedAssetName(displayCandidates, rec.asset_name)) {
      console.warn(`[${DEPT}] 候補外銘柄「${rec.asset_name}」が返されたため安全側でWAITに補正`);
      rec = { asset_id: '', asset_name: 'なし', action: 'WAIT', recommended_amount: 0, reason: '候補外銘柄のため見送り' };
      if (signal !== 'DEFEND') signal = 'WAIT';
    }
    const recAction = rec.action || (signal === 'WAIT' || signal === 'DEFEND' ? signal : 'ACCUMULATE');
    const noAsset   = !rec.asset_name || rec.asset_name === 'なし' || rec.asset_name === '';
    const noAction  = recAction === 'WAIT' || recAction === 'DEFEND';
    const recAmt    = (noAsset || noAction) ? 0 : (rec.recommended_amount ?? 0);
    const recReason = (rec.reason ?? comment).slice(0, 100);

    await sheets.upsertRow('agent_votes', ['date', 'department'], {
      date,
      department:            DEPT,
      signal,
      confidence:            String(confidence),
      comment,
      recommendation_asset:  rec.asset_name ?? '',
      recommendation_amount: String(recAmt),
    });

    await Promise.all([
      sheets.upsertRow('department_recommendations', ['date', 'department'], {
        date,
        department:         DEPT,
        asset_id:           rec.asset_id  ?? '',
        asset_name:         rec.asset_name ?? 'なし',
        action:             recAction,
        recommended_amount: String(recAmt),
        confidence:         String(confidence),
        reason:             recReason,
      }),
      sheets.upsertRow('agent_recommendations', ['date', 'department'], {
        date,
        task_id:             date,
        agent_name:          AGENT_NAME,
        department:          DEPT,
        recommendation_type: recAction,
        asset_id:            rec.asset_id  ?? '',
        asset_name:          rec.asset_name ?? 'なし',
        amount:              String(recAmt),
        confidence:          String(confidence),
        reason_summary:      recReason,
      }),
    ]);

    console.log(`[${DEPT}] 投票完了: ${signal}(${confidence}%) risk=${parsed.risk_level} — ${comment}`);
    console.log(`[${DEPT}] 提案: ${recAction} ${rec.asset_name || 'なし'} ¥${recAmt.toLocaleString()}`);
    return { signal, confidence, comment, risk_level: parsed.risk_level, recommendation: rec };
  } catch (err) {
    const comment = `⚠️ ${err.message}。安全側でWAIT（分析スキップ）`;
    console.error(`[${DEPT}] ${comment}`);
    await writeFallbackVote(date, comment).catch(e =>
      console.error(`[${DEPT}] フォールバック記録も失敗: ${e.message}`)
    );
    return { signal: 'WAIT', confidence: 0, comment };
  }
}

async function writeFallbackVote(date, comment) {
  await sheets.upsertRow('agent_votes', ['date', 'department'], {
    date, department: DEPT, signal: 'WAIT', confidence: '0', comment: comment.slice(0, 200),
    recommendation_asset: '', recommendation_amount: '0',
  });
  await Promise.all([
    sheets.upsertRow('department_recommendations', ['date', 'department'], {
      date, department: DEPT, asset_id: '', asset_name: 'なし', action: 'WAIT',
      recommended_amount: '0', confidence: '0', reason: comment.slice(0, 100),
    }),
    sheets.upsertRow('agent_recommendations', ['date', 'department'], {
      date, task_id: date, agent_name: AGENT_NAME, department: DEPT,
      recommendation_type: 'WAIT', asset_id: '', asset_name: 'なし', amount: '0',
      confidence: '0', reason_summary: comment.slice(0, 100),
    }),
  ]);
}

module.exports = { analyze };
