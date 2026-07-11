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
  "comment": "<100字以内。リスク数値根拠必須。絵文字・Markdown禁止。>",
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

【想定損失など金額の扱い（最重要）】
comment・reason に「想定損失¥〇〇」のような金額を書く場合は、
「推奨額×想定下落率」のように算出根拠を示せる場合のみ書くこと。
根拠を示せない当てずっぽうの金額は書かないこと。その場合はVIX水準・ボラティリティ・集中度など
定性的なリスク説明に留めること。
`.trim();

function parseJson(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { dept: DEPT, signal: 'WAIT', confidence: 60, risk_level: 'MEDIUM', key_points: [], comment: 'JSON解析失敗' };
  try { return JSON.parse(m[0]); } catch {
    return { dept: DEPT, signal: 'WAIT', confidence: 60, risk_level: 'MEDIUM', key_points: [], comment: 'JSON解析失敗' };
  }
}

async function buildContext(date) {
  // positions は portfolio_status.positions_json から取得（Single Source of Truth）
  const [mkt, pf] = await Promise.all([
    sheets.getLatestRow('market_data'),
    sheets.getLatestRow('portfolio_status').catch(() => null),
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

  return lines.join('\n');
}

async function analyze(date) {
  console.log(`[${DEPT}] 分析開始 ${date}`);
  const context = await buildContext(date);
  const system  = constitution.prefix() + SYSTEM;

  const raw    = await ask(system, context, { num_predict: 1200 });
  const parsed = parseJson(raw);

  const signal     = parsed.signal ?? 'WAIT';
  const confidence = parsed.confidence ?? 60;
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

  console.log(`[${DEPT}] 投票完了: ${signal}(${confidence}%) risk=${parsed.risk_level} — ${comment}`);
  console.log(`[${DEPT}] 提案: ${recAction} ${rec.asset_name || 'なし'} ¥${recAmt.toLocaleString()}`);
  return { signal, confidence, comment, risk_level: parsed.risk_level, recommendation: rec };
}

module.exports = { analyze };
