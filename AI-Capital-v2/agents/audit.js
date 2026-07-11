'use strict';

/**
 * audit.js — 審査部（鬼塚ガイ）
 * 他部署の投票を読み込み、論理の整合性・バイアス・根拠を審査した上で
 * 独立した投票・推奨を出力する。
 *
 * 実行順序上、market/portfolio/risk の後に呼び出すこと。
 */

const { ask }      = require('../lib/ollama');
const sheets       = require('../lib/sheets');
const constitution = require('../lib/constitution');
const { fgDisplay } = require('../lib/marketUtils');

const DEPT       = '審査部';
const AGENT_NAME = '鬼塚ガイ';

const SYSTEM = `
あなたはAI Capital「審査部」部長 鬼塚ガイです。

【あなたの役割】
他のAI社員（マーケット分析部・リスク管理部・ポートフォリオ管理部）の投票と根拠を審査し、
論理の整合性・数値の使い方・バイアスの有無を確認した上で、
あなた自身の独立した判断で投票・推奨を出力する。

【判断フロー】
1. 各部署の signal・confidence・comment を読む
2. 論理の穴、数値の誤用、過度な楽観/悲観を探す
3. 市場データとの整合性を確認する
4. 以上を踏まえ、独立した立場から投票する（他部署への同調禁止）

【スタンス】
- 問題がなければ賛同（ただし同じ理由の繰り返しは禁止）
- 論理の穴があれば指摘して異なる判断を出す
- バイアスを見つけたら反論も辞さない
- 「みんながACCUMULATEだから私もACCUMULATE」は禁止

【信頼度について】
他部署の議論の質が低ければ自分のconfidenceも下げる。
自分が独自の観点を持てている場合はconfidenceを上げる。

【コメント記述ルール（最重要）】
comment には必ず3部署それぞれへの審査意見を含めること：
- マーケット分析部の銘柄選定・根拠への評価
- リスク管理部のリスク指摘への評価（過大/過小/妥当）
- ポートフォリオ管理部の金額案への評価
最後に鬼塚自身の独立した結論1文。
例：「神谷のSOX選定は逆張り根拠が明確。黒崎の警戒は適切だが過剰ではない。アオイの金額は保守的で妥当。私はACCUMULATEを支持する。」

【JSON出力スキーマ（必ず守ること）】
自由文・Markdown禁止。以下のJSONのみ出力。
{
  "dept": "審査部",
  "signal": "BUY|ACCUMULATE|WAIT|DEFEND|SELL",
  "confidence": <0-100の整数>,
  "audit_points": [
    "<マーケット分析部への審査コメント（銘柄・根拠を評価）>",
    "<リスク管理部への審査コメント（リスク指摘を評価）>",
    "<ポートフォリオ管理部への審査コメント（金額案を評価）>"
  ],
  "comment": "<150字以内。3部署審査意見＋自身の結論。絵文字・Markdown禁止。日本語のみ。>",
  "recommendation": {
    "asset_id": "<推奨銘柄のasset_id。WAITなら空文字>",
    "asset_name": "<推奨銘柄の略称。WAITなら'なし'>",
    "action": "ACCUMULATE|BUY|WAIT|DEFEND|SELL",
    "recommended_amount": <推奨投資額（円整数）。WAITなら0>,
    "reason": "<30字以内。審査を経た独自根拠>"
  }
}

【recommendation 記入ガイド】
- 他部署と同じ銘柄でも金額が異なれば独立した判断として有効
- WAIT・DEFEND: recommended_amount=0、asset_id=''、asset_name='なし'
- ACCUMULATE: 200,000〜500,000円（審査部は保守的な金額設定を好む）
- BUY: 400,000〜800,000円
`.trim();

function parseJson(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { dept: DEPT, signal: 'WAIT', confidence: 50, audit_points: [], comment: 'JSON解析失敗' };
  try { return JSON.parse(m[0]); } catch {
    return { dept: DEPT, signal: 'WAIT', confidence: 50, audit_points: [], comment: 'JSON解析失敗' };
  }
}

async function buildContext(date) {
  const [mkt, votes] = await Promise.all([
    sheets.getLatestRow('market_data').catch(() => null),
    sheets.getRowsByDate('agent_votes', date).catch(() => []),
  ]);

  const lines = [];

  // 他部署の投票結果
  const otherVotes = votes.filter(v => v.department !== DEPT);
  if (otherVotes.length > 0) {
    lines.push('【他部署の投票結果（審査対象）】');
    for (const v of otherVotes) {
      lines.push(
        `${v.department}: signal=${v.signal} confidence=${v.confidence}%\n` +
        `コメント: ${v.comment}\n` +
        `推奨銘柄: ${v.recommendation_asset || 'なし'} ¥${(parseInt(v.recommendation_amount || 0)).toLocaleString()}`
      );
    }
    if (otherVotes.length < 3) {
      lines.push(`※ まだ${3 - otherVotes.length}部署の投票が完了していない可能性あり`);
    }
  } else {
    lines.push('【他部署の投票結果】まだ投票なし（市場データのみで独立判断すること）');
  }

  // 市場データ
  if (mkt) {
    lines.push('');
    lines.push('【市場データ（GAS確定値）】');
    lines.push(`Fear & Greed: ${fgDisplay(mkt.fear_greed)}`);
    lines.push(`VIX: ${mkt.vix}`);
    lines.push(`NASDAQ100: ${mkt.nasdaq100}%`);
    lines.push(`SOX: ${mkt.sox}%`);
    lines.push(`S&P500: ${mkt.sp500}%`);
    lines.push(`ドル円: ${mkt.usdjpy}`);
  }

  return lines.join('\n');
}

async function analyze(date) {
  console.log(`[${DEPT}] 分析開始 ${date}`);
  const context = await buildContext(date);
  const system  = constitution.prefix() + SYSTEM;

  const raw    = await ask(system, context, { num_predict: 1000 });
  const parsed = parseJson(raw);

  const signal     = parsed.signal ?? 'WAIT';
  const confidence = parsed.confidence ?? 50;
  const comment    = (parsed.comment ?? '').slice(0, 200);

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

  const auditNote = parsed.audit_points ? parsed.audit_points.join(' / ') : '';
  console.log(`[${DEPT}] 投票完了: ${signal}(${confidence}%) — ${comment}`);
  console.log(`[${DEPT}] 審査: ${auditNote.slice(0, 80)}`);
  console.log(`[${DEPT}] 提案: ${recAction} ${rec.asset_name || 'なし'} ¥${recAmt.toLocaleString()}`);
  return { signal, confidence, comment, recommendation: rec, audit_points: parsed.audit_points };
}

module.exports = { analyze };
