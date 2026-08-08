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
const { getDisplayCandidates, isAllowedAssetName } = require('../lib/candidateGroups');

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
- 本日の買付候補: 記事の「🥇Core候補/🚀Growth候補/🛡Defense候補」欄に表示されるのと
  完全に同じ3銘柄（各カテゴリの最上位1件）のみ。ath_gap_pct(ATH乖離%) daily_change_pct(前日比%)
  chg_5d(5日変化%) chg_20d(20日変化%) rebound_rate(20日安値からの反発%) score(総合評価スコア)

【候補銘柄の選択ルール（最重要・厳守）】
あなたが提案できる銘柄は、コンテキストに提示された「本日の買付候補」3件（Core/Growth/Defenseそれぞれの代表1件）に限る。
まずCore候補・Growth候補・Defense候補の3つを比較すること。その上で「今日はGrowth候補を推します」のように、
必ずこの3件のいずれか1件を選ぶこと。コンテキストに存在しない銘柄（例：候補表示に出ていない個別テーマ銘柄）を
新たに提案することは絶対禁止。3件のいずれも推奨できない場合はWAITとし、asset_nameは「なし」にすること。

【分析基準（厳守）】
VIX: <15=SAFE <20=SAFE/CAUTION <30=CAUTION >30=DANGER
Fear & Greed: 0-25=極端な恐怖 26-45=恐怖 46-54=中立 55-75=強欲 76-100=極端な強欲

総合市場評価（いずれか1つの指標だけでACCUMULATE/BUYを決めないこと）:
以下を総合して判断すること。複数指標が同じ方向を示す場合のみ、その方向のシグナルを検討する。
- Fear & Greed（市場心理の一つの表れ。低い＝即買いではない）
- VIX（不確実性の水準）
- 買付候補のATH乖離率・前日比・5日/20日変化率（価格モメンタム）
- 候補銘柄のスコア・順位（候補一覧のRule Engine総合評価）
- ポートフォリオ状況（保有比率・目標配分との乖離。コンテキストに[既存保有]表記があれば参照）
Fear & Greedが低い、あるいはATH乖離が大きいというだけでACCUMULATEを結論付けることは禁止。

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

async function getTodayDisplayCandidates(date) {
  const candidatesRaw = await sheets.getRowsByDate('candidate_assets', date).catch(() => []);
  return getDisplayCandidates(candidatesRaw);
}

async function buildContext(date, displayCandidates) {
  const mkt = await sheets.getLatestRow('market_data');

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

  if (displayCandidates.length > 0) {
    lines.push('');
    lines.push('【本日の買付候補（この3件の中からのみ選ぶこと。ここに無い銘柄の提案は禁止）】');
    displayCandidates.forEach(c => lines.push(`${c.label}: ${formatCandidate(c)}`));
  } else {
    lines.push('');
    lines.push('【本日の買付候補】データ未取得（asset_masterを確認すること）');
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
    const confidence   = parsed.confidence ?? 50;
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

    console.log(`[${DEPT}] 投票完了: ${signal}(${confidence}%) — ${comment}`);
    console.log(`[${DEPT}] 提案: ${recAction} ${rec.asset_name || 'なし'} ¥${recAmt.toLocaleString()}`);
    return { signal, confidence, comment, recommendation: rec };
  } catch (err) {
    // LLM/Sheets の一時的な失敗（タイムアウト・abort等）で部署が記事から丸ごと
    // 欠落しないよう、安全側WAITで全シートへフォールバック記録する。
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
