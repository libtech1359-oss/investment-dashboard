'use strict';

/**
 * market.js — マーケット分析部
 * 参照: market_data, candidate_assets
 * 出力: agent_votes への投票
 */

const { ask }      = require('../lib/ollama');
const sheets       = require('../lib/sheets');
const constitution = require('../lib/constitution');
const { fgDisplay } = require('../lib/marketUtils');

const DEPT       = 'マーケット分析部';
const AGENT_NAME = '神谷シン';

const SYSTEM = `
あなたはAI Capital「マーケット分析部」部長です。

【部署の役割】
市場データのみを分析してシグナルを投票する。ポートフォリオや注文は参照しない。
冷静・数字重視。チャンスを見つけたら積極的に発信する攻めの姿勢。

【入力データ】
- market_data: date | fear_greed | vix | sp500 | nasdaq100 | sox | gold | usdjpy
  各列の数値: fear_greed(0-100) vix(数値) sp500/nasdaq100/sox/gold(前日比%) usdjpy(円)
- candidate_assets: nav_pricesから算出した確定基準価格ベースの候補銘柄データ
  列: nav(最新基準価格) ath_nav(最高値) ath_gap_pct(ATH乖離%) daily_change_pct(前日比%)
      chg_5d(5日変化%) chg_20d(20日変化%) rebound_rate(20日安値からの反発%) score(逆張りスコア)
  nav_ok=FALSE の銘柄は nav_prices にデータが未蓄積（スコア=0は中立値）

【分析基準（厳守）】
VIX: <15=SAFE <20=SAFE/CAUTION <30=CAUTION >30=DANGER
Fear & Greed: 0-25=極端な恐怖 26-45=恐怖 46-54=中立 55-75=強欲 76-100=極端な強欲

逆張りシグナル条件（1つ以上該当でACCUMULATEを検討）:
- Fear & Greed <= 40（恐怖局面）
- NASDAQ 前日比 <= -2%
- 買付候補ATH乖離率 <= -15%
- chg_5d <= -5%（5日間で5%以上下落）

【JSON出力スキーマ（必ず守ること）】
自由文・Markdown禁止。以下のJSONのみ出力。
{
  "dept": "マーケット分析部",
  "signal": "BUY|ACCUMULATE|WAIT|DEFEND|SELL",
  "confidence": <0-100の整数>,
  "key_points": ["<根拠付き観測点1>", "<観測点2>", "<観測点3>"],
  "comment": "<100字以内。数値根拠必須。絵文字・Markdown禁止。日本語のみ。>",
  "recommendation": {
    "asset_id": "<候補銘柄のasset_id。WAITの場合は空文字>",
    "asset_name": "<候補銘柄のshort_name。WAITの場合はなし>",
    "action": "ACCUMULATE|BUY|WAIT|DEFEND|SELL",
    "recommended_amount": <推奨投資額（円整数）。WAITの場合は0>,
    "reason": "<30字以内の根拠>"
  }
}

【recommendation 記入ガイド】
- マーケット分析部は必ず具体的な銘柄を1つ選ぶこと（WAITでも「次に狙う銘柄」を選定）
- ACCUMULATE（観測ポジション）: 300,000〜600,000円 / BUY（本格買付）: 600,000〜2,000,000円
- WAIT・DEFEND: recommended_amount=0、asset_id=''、asset_name='なし'
- asset_idは候補銘柄一覧のasset_idをそのまま使うこと（例: nasdaq100, sox, fang）
`.trim();

function parseJson(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { dept: DEPT, signal: 'WAIT', confidence: 50, key_points: [], comment: 'JSON解析失敗' };
  try { return JSON.parse(m[0]); } catch {
    return { dept: DEPT, signal: 'WAIT', confidence: 50, key_points: [], comment: 'JSON解析失敗' };
  }
}

function formatCandidate(c) {
  const fullLabel = c.full_name ? `（${c.full_name}）` : '';
  const navLabel  = c.nav_ok === 'FALSE' ? ' ※基準価格データ未蓄積' : '';
  const extras    = [];
  if (c.chg_5d  && c.chg_5d  !== 'N/A') extras.push(`5日${c.chg_5d}%`);
  if (c.chg_20d && c.chg_20d !== 'N/A') extras.push(`20日${c.chg_20d}%`);
  if (c.rebound_rate && c.rebound_rate !== 'N/A') extras.push(`反発${c.rebound_rate}%`);
  const extStr = extras.length ? ` (${extras.join(' ')})` : '';
  return `・Rank${c.rank} ${c.asset_name}${fullLabel}: ATH乖離${c.ath_gap_pct}% 前日比${c.daily_change_pct}%${extStr} スコア${c.score}${navLabel}`;
}

async function buildContext(date) {
  const [mkt, candidates] = await Promise.all([
    sheets.getLatestRow('market_data'),
    sheets.getRowsByDate('candidate_assets', date).catch(() => []),
  ]);

  const lines = [];

  if (mkt) {
    lines.push('【最新市場データ】');
    lines.push(`日付: ${mkt.date}`);
    lines.push(`Fear & Greed: ${fgDisplay(mkt.fear_greed)}`);
    lines.push(`VIX: ${mkt.vix}`);
    lines.push(`NASDAQ100: ${mkt.nasdaq100}%`);
    lines.push(`S&P500: ${mkt.sp500}%`);
    lines.push(`SOX: ${mkt.sox}%`);
    lines.push(`ゴールド: ${mkt.gold}%`);
    lines.push(`ドル円: ${mkt.usdjpy}`);
  } else {
    lines.push('【市場データ】未取得');
  }

  if (candidates.length > 0) {
    lines.push('');
    lines.push('【買付候補銘柄（逆張りスコア順）】');
    candidates.sort((a, b) => parseInt(a.rank || 99) - parseInt(b.rank || 99));
    candidates.forEach(c => lines.push(formatCandidate(c)));
  } else {
    lines.push('');
    lines.push('【買付候補銘柄】データ未取得（asset_masterを確認すること）');
  }

  return lines.join('\n');
}

async function analyze(date) {
  console.log(`[${DEPT}] 分析開始 ${date}`);
  const context = await buildContext(date);
  const system  = constitution.prefix() + SYSTEM;

  const raw    = await ask(system, context, { num_predict: 1200 });
  const parsed = parseJson(raw);

  const signal     = parsed.signal ?? 'WAIT';
  const confidence = parsed.confidence ?? 50;
  const comment    = (parsed.comment ?? '').slice(0, 200);

  // rec を先に確定（agent_votes と department_recommendations 両方で使用）
  const rec       = parsed.recommendation ?? {};
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

  console.log(`[${DEPT}] 投票完了: ${signal}(${confidence}%) — ${comment}`);
  console.log(`[${DEPT}] 提案: ${recAction} ${rec.asset_name || 'なし'} ¥${recAmt.toLocaleString()}`);
  return { signal, confidence, comment, recommendation: rec };
}

module.exports = { analyze };
