'use strict';

/**
 * portfolio.js — ポートフォリオ管理部
 * 参照: portfolio_status, positions, candidate_assets
 * 出力: agent_votes への投票
 *
 * 安全原則: portfolio_status が取得できない場合は LLM を呼ばず即時 WAIT 投票。
 * 「分からない時は止まる」 — 現金100%フォールバックは使用しない。
 */

const { ask }      = require('../lib/ollama');
const sheets       = require('../lib/sheets');
const constitution = require('../lib/constitution');

const DEPT       = 'ポートフォリオ管理部';
const AGENT_NAME = '橘アオイ';

const SYSTEM = `
あなたはAI Capital「ポートフォリオ管理部」部長です。

【部署の役割】
ファンド全体の配分・現金比率・保有銘柄バランスを分析してシグナルを投票する。
「何を買うか」より「どう配分するか」が本分。数字と比率で語る実務家。

【入力データ】
- portfolio_status: 各列の定義
  cash     = 自由に使える現金（pending・filledどちらも除いた純粋な待機資金）
  pending  = 注文中・未約定の資金（発注済みだが証券会社未処理）
  invested = 約定済みポジションの現在評価額（nav_prices由来の時価）
  unrealized_pl = invested - 取得原価（含み損益）
  cash_ratio = cash / total_assets × 100
- positions: 保有銘柄一覧（nav_pricesから算出した時価データ付き）
  列: asset_name | cost_basis | market_value | unrealized_pl | current_nav | ath_nav | ath_gap_pct | daily_change_pct
  current_nav は nav_prices の最新確定基準価格（公式価格データベース）
- candidate_assets: nav_pricesから算出した確定基準価格ベースの候補銘柄
  nav_ok=FALSE の銘柄は nav_prices にデータ未蓄積（スコア=0は中立値、推奨候補から外すこと）

【投資余力（厳守）】
投資余力 = cash（自由現金）のみ
pending（注文中資金）は既に拘束済みのため含めないこと
「cash + pending = 投資余力」という計算は絶対に行わないこと

【判断基準】
cash_ratio >= 70%: 投資余力大 → BUY/ACCUMULATE を積極的に検討
cash_ratio >= 40%: 通常 → ACCUMULATE を検討
cash_ratio < 20%: 自由現金不足 → WAIT または DEFEND
含み損益がマイナス大: リスク管理優先 → WAIT

【予算配分ルール（ACCUMULATEの場合）】
cash × 3%（観測ポジション）を上限とすること。
pendingは除外して計算すること。
配分額は「保有比率（低いほど配分余地あり）」「目標配分との乖離（不足なら優先）」「現金比率」「資産分散（未保有カテゴリーを優先）」を総合して決定すること。
ATH乖離率の大きさだけを根拠に配分額を決めることは禁止（候補選定・値動きの評価は神谷シンの担当）。

【JSON出力スキーマ】
{
  "dept": "ポートフォリオ管理部",
  "signal": "BUY|ACCUMULATE|WAIT|DEFEND|SELL",
  "confidence": <0-100の整数>,
  "key_points": ["<観測点1>", "<観測点2>", "<観測点3>"],
  "comment": "<100字以内。数値根拠必須。絵文字・Markdown禁止。>",
  "recommendation": {
    "asset_id": "<候補銘柄のasset_id。WAITの場合は空文字>",
    "asset_name": "<候補銘柄のshort_name。WAITの場合はなし>",
    "action": "ACCUMULATE|BUY|HOLD|WAIT|DEFEND|SELL",
    "recommended_amount": <推奨投資額（円整数）。WAITの場合は0>,
    "reason": "<30字以内。金額根拠（現金比率×○%など）>"
  }
}

【recommendation 記入ガイド】
- ポートフォリオ管理部は「金額」を決定する部署。銘柄は候補1位を採用する
- comment（要約）で言及した銘柄と recommendation.asset_name は必ず一致させること。
  例：comment で「ゴールドが最有力」と書いたなら asset_name も「ゴールド」にすること。
  comment と asset_name が食い違う出力は禁止。
- 現金比率70%以上: ACCUMULATE 300,000〜1,000,000円 / 40〜70%: 300,000円以内 / 20%未満: WAIT
- 既存保有銘柄の評価が主目的の場合はaction=HOLDも可
- asset_idは候補銘柄一覧のasset_idをそのまま使うこと
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
  return `・Rank${c.rank} ${c.asset_name}${fullLabel}: ATH乖離${c.ath_gap_pct}% 前日比${c.daily_change_pct}% score=${c.score}${navLabel}`;
}

async function buildContext(date) {
  // positions は portfolio_status.positions_json から取得（Single Source of Truth）
  const [pf, candidates] = await Promise.all([
    sheets.getLatestRow('portfolio_status'),
    sheets.getRowsByDate('candidate_assets', date).catch(() => []),
  ]);

  const positions = JSON.parse(pf?.positions_json || '[]').map(p => ({
    asset_name:      p.name,
    quantity:        '1',
    cost_basis:      p.cost_basis,
    market_value:    p.market_value,
    unrealized_pl:   p.unrealized_pl,
    current_nav:     p.current_nav,
    ath_gap_pct:     p.ath_gap_pct,
    daily_change_pct: p.daily_change_pct,
  }));

  // ── 安全原則: portfolio_status 欠落時は即時例外 ──
  // フォールバック値を使わない。保有資産がある状態で現金100%と誤認すると危険。
  if (!pf) {
    throw new Error('portfolio_status データ未取得');
  }

  const lines = [];

  lines.push('【ファンド状況（portfolio_status）】');
  lines.push(`総資産: ¥${parseInt(pf.total_assets || 0).toLocaleString()}`);
  lines.push(`現金残高（投資可能）: ¥${parseInt(pf.cash || 0).toLocaleString()}`);
  lines.push(`注文中資金（未約定）: ¥${parseInt(pf.pending || 0).toLocaleString()}`);
  lines.push(`投資中資金（約定済み評価額）: ¥${parseInt(pf.invested || 0).toLocaleString()}`);
  lines.push(`含み損益: ¥${parseInt(pf.unrealized_pl || 0).toLocaleString()}`);
  lines.push(`現金比率: ${pf.cash_ratio}%`);

  if (positions.length > 0) {
    lines.push('');
    lines.push('【保有銘柄（positions）】');
    positions.forEach(p => {
      const navStr = p.current_nav && p.current_nav !== 'N/A'
        ? ` 基準価格¥${parseInt(p.current_nav).toLocaleString()}`
        : '';
      const athStr = p.ath_gap_pct && p.ath_gap_pct !== 'N/A'
        ? ` ATH乖離${p.ath_gap_pct}%`
        : '';
      lines.push(
        `・${p.asset_name}: ${p.quantity}口 ` +
        `コスト¥${parseInt(p.cost_basis || 0).toLocaleString()} ` +
        `時価¥${parseInt(p.market_value || 0).toLocaleString()} ` +
        `損益¥${parseInt(p.unrealized_pl || 0).toLocaleString()}` +
        navStr + athStr
      );
    });
  } else {
    lines.push('');
    lines.push('【保有銘柄】なし（全額現金）');
  }

  if (candidates.length > 0) {
    lines.push('');
    lines.push('【買付候補（candidate_assets）】');
    candidates.sort((a, b) => parseInt(a.rank || 99) - parseInt(b.rank || 99));
    candidates.forEach(c => lines.push(formatCandidate(c)));
  } else {
    lines.push('');
    lines.push('【買付候補】データなし（asset_masterシートを確認すること）');
  }

  return lines.join('\n');
}

async function analyze(date) {
  console.log(`[${DEPT}] 分析開始 ${date}`);

  let context;
  try {
    context = await buildContext(date);
  } catch (err) {
    // portfolio_status 欠落 → 安全側でWAIT即時投票（LLM呼び出しなし）
    const comment = `⚠️ ${err.message}。安全側でWAIT（分析スキップ）`;
    console.error(`[${DEPT}] ${comment}`);
    await sheets.upsertRow('agent_votes', ['date', 'department'], {
      date,
      department: DEPT,
      signal:     'WAIT',
      confidence: '0',
      comment:    comment.slice(0, 200),
    });
    return { signal: 'WAIT', confidence: 0, comment };
  }

  const system = constitution.prefix() + SYSTEM;
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
