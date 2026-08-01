'use strict';

/**
 * signalAggregator.js — LLM不使用・機械判定のみ
 *
 * agent_votes シートを読み込み、加重多数決で final_signal を決定し
 * final_decisions シートへ書き込む。
 *
 * シグナル重み:
 *   BUY        +2.0
 *   ACCUMULATE +1.0
 *   WAIT        0.0
 *   DEFEND     -1.0
 *   SELL       -2.0
 *
 * 判定閾値（正規化スコア）:
 *   >= 1.5 → BUY
 *   >= 0.5 → ACCUMULATE
 *   >= -0.3 → WAIT
 *   >= -1.0 → DEFEND
 *   <  -1.0 → SELL
 *
 * WAIT見送り防止（2026-08-01〜）:
 *   AI Capitalは「リスクを避けるAI」ではなく「適切なリスクを取りながら長期資産形成を行うAI」。
 *   final_signalがWAITでも、現金比率70%以上・投資可能資金あり・Rule Engine上位候補が僅差・
 *   重大リスクなし（VIX高騰/NASDAQ急落なし）・Fear&GreedがExtreme Greedでない、を全て満たす
 *   場合は小額（30〜50万円）の観測ポジション構築（ACCUMULATE）へ切り替える
 *   （evaluateObservationOverride関数、閾値は config/decisionWeights.js の OBSERVATION_*）。
 *   ただしHARD RULE（システム異常・監査エラー・portfolio_status異常・データ取得失敗）は対象外。
 *
 * 秘書室長タイブレーク（2026-08-02〜）:
 *   4部署の投票がACCUMULATE:2/WAIT:2の同票になった場合のみ、上の加重多数決（正規化スコア）
 *   を終了し秘書室長が最終裁定する（evaluateSecretaryTieBreak関数）。3対1・4対0等の通常の
 *   多数決結果は変更しない。Fear&Greed<=50・Rule Engine上位候補score>=0.70・現金比率>=50%を
 *   全て満たせばACCUMULATE、満たさなければWAIT（閾値は config/decisionWeights.js の TIEBREAK_*）。
 *   HARD RULE（システム異常・監査エラー・portfolio_status異常・データ取得失敗・重大リスク
 *   イベント）を検知した場合はタイブレークを実施せずWAITを返す。実行時は必ず
 *   `[Decision]`ブロックのログを出力する（部署投票内訳・裁定理由・結果）。
 *
 * 銘柄選択ロジック（部署の議論を中心に、客観指標・ポートフォリオ全体最適化は「補正」として加える構造）:
 *   voteScore（部署の信頼度加重支持率, 0〜1）を基礎スコアとし、
 *   + ruleAdjust（Rule Engine: candidate_assetsの総合評価スコアランク。VIXが高いほど発言力を弱める。
 *     Fear&Greedは全銘柄共通の値のため銘柄間の相対順位を左右せず、この補正には使わない）
 *   + holdingRatioAdjust（① 保有比率が高いほど連続的に減点。集中投資の抑制）
 *   + allocationAdjust（② config/targetAllocation.js の目標配分との乖離。不足なら加点・超過なら減点）
 *   + cooldownAdjust（③ 直近の連続購入を減点。ただしRule Engineが強い日は無効化される）
 *   + orderAssist（規則エンジンの推奨第1候補への極小の後押し）
 *   + categoryAdjust（④ Core資産（オルカン・S&P500）への僅かな後押し。長期資産形成のため、
 *     僅差の場合にCore資産が選ばれやすくなるよう config/categoryBonus.js で設定）
 *   + balanceAdjust（⑤ 直近 final_decisions での採用履歴が偏っている銘柄を軽く減点。
 *     config/candidatePenalty.js で設定。禁止ではなく僅差の場合のみ他候補に機会を残す補正）
 *   をそれぞれ ±config/decisionWeights.js の範囲で加算する。
 *   重みは config/decisionWeights.js（採用履歴補正は config/candidatePenalty.js）で管理する
 *   （コードに固定値を埋め込まない）。
 *   voteScoreは0〜1の全域を持つのに対し各補正の振れ幅は小さいため、部署支持率の大差は
 *   覆せず、僅差・ほぼ同点のケースのみ客観指標・ポートフォリオ状況が結論を左右する。
 *   「一番スコアが高い銘柄を買う」のではなく「長期ポートフォリオ全体として最適な判断をする」
 *   という設計思想のもと、単一銘柄への偏りを補正で抑制する。
 *   reason にどの部署がどの銘柄を推し、なぜ勝者を採用したかを必ず記録する（Explainability）。
 *
 * 金額決定:
 *   勝利銘柄を推薦した部署の平均額（推薦なし時は cash × 3%）
 */

const sheets            = require('./sheets');
const W                 = require('../config/decisionWeights');
const TARGET_ALLOCATION = require('../config/targetAllocation');
const CB                = require('../config/categoryBonus');
const CP                = require('../config/candidatePenalty');

const SIGNAL_WEIGHT = {
  BUY: 2.0, ACCUMULATE: 1.0, WAIT: 0.0, DEFEND: -1.0, SELL: -2.0,
  // 財務戦略部（現在未配線・config/financeStrategy.js有効化後に使用）
  HOLD: 0.0, REDUCE: -1.0, REBALANCE: 0.0,
};

// シグナルの日本語ラベル（reasonの説明文で使用。内部の英語シグナル名を記事に出さないため）
const SIGNAL_LABEL_JA = {
  BUY: '買付', ACCUMULATE: '観測ポジション構築', WAIT: '監視継続', DEFEND: '防御的判断', SELL: '売却',
};

// 部署→AI社員名（reasonの説明文で使用。publisher.js buildContext のDEPT_NAMESと同じ対応）
const DEPT_PERSON = {
  'マーケット分析部':     '神谷シン',
  'リスク管理部':         '黒崎ミサキ',
  'ポートフォリオ管理部': '橘アオイ',
  '審査部':               '鬼塚ガイ',
};

function todayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// 'YYYY-MM-DD' に日数を加減算する（③ 直近買付履歴のクールダウン判定に使用）
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
  const from = new Date(`${fromStr}T00:00:00Z`);
  const to   = new Date(`${toStr}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

function safeParseJson(str, fallback) {
  try { return JSON.parse(str || '[]'); }
  catch { return fallback; }
}

// HARD RULE検知: 各部署の投票コメントからシステム異常/エラー/安全側WAIT（システム異常・
// 監査エラー・portfolio_status異常でLLMを呼ばず即時WAIT投票したケース等）を検出する。
// evaluateObservationOverride・evaluateSecretaryTieBreak共通で使用する。
function detectHardIssue(votes) {
  return votes.find(v => {
    const comment = String(v.comment || '');
    return comment.includes('JSON解析失敗') || comment.includes('分析スキップ') || parseFloat(v.confidence) === 0;
  }) || null;
}

// WAIT見送り防止: 現金余力がありリスクが許容範囲内なら、WAITではなく小額の観測
// ポジション構築（ACCUMULATE）へ切り替えるべきか判定する。
// HARD RULE（システム異常・監査エラー・portfolio_status異常・データ取得失敗）は対象外のまま維持する
// （エラー/安全側WAIT投票を検知した時点で即座に見送る）。
async function evaluateObservationOverride(date, votes) {
  const hardIssue = detectHardIssue(votes);
  if (hardIssue) return { ok: false, reason: `${hardIssue.department}でシステム異常/エラーを検知` };

  const [pf, mkt] = await Promise.all([
    sheets.getLatestRowAsOf('portfolio_status', date).catch(() => null),
    sheets.getLatestRowAsOf('market_data', date).catch(() => null),
  ]);
  if (!pf)  return { ok: false, reason: 'portfolio_status取得不可' };
  if (!mkt) return { ok: false, reason: '市場データ取得不可' };

  const cashRatio = parseFloat(pf.cash_ratio ?? 0);
  const cash      = parseFloat(pf.cash ?? 0);
  const vix       = parseFloat(mkt.vix ?? 0);
  const nasdaq    = parseFloat(mkt.nasdaq100 ?? 0);
  const fg        = parseFloat(mkt.fear_greed ?? 50);

  if (cashRatio < W.OBSERVATION_MIN_CASH_RATIO_PCT)
    return { ok: false, reason: `現金比率${cashRatio}%が下限(${W.OBSERVATION_MIN_CASH_RATIO_PCT}%)未達` };
  if (cash < W.OBSERVATION_MIN_AMOUNT)
    return { ok: false, reason: '投資可能資金不足' };
  if (vix >= W.OBSERVATION_MAX_VIX)
    return { ok: false, reason: `VIX${vix}が高リスク水準` };
  if (nasdaq <= W.OBSERVATION_MAX_NASDAQ_DROP_PCT && vix >= 25)
    return { ok: false, reason: 'NASDAQ急落とVIX上昇が重なる高リスク局面' };
  if (fg > W.OBSERVATION_MAX_FEAR_GREED)
    return { ok: false, reason: `Fear&Greed${fg}がExtreme Greed水準` };

  const candidates = await sheets.getRowsByDate('candidate_assets', date).catch(() => []);
  if (candidates.length < 2) return { ok: false, reason: '候補銘柄データ不足' };

  const sorted = [...candidates].sort((a, b) => (parseInt(a.rank) || 99) - (parseInt(b.rank) || 99));
  const top1   = parseFloat(sorted[0].score ?? 0);
  const top2   = parseFloat(sorted[1].score ?? 0);
  const gapPct = top1 !== 0 ? Math.abs(top1 - top2) / Math.abs(top1) * 100 : 100;
  if (gapPct > W.OBSERVATION_MAX_SCORE_GAP_PCT)
    return { ok: false, reason: `Rule Engine上位候補のスコア差が大きい(${gapPct.toFixed(1)}%)` };

  const positions       = safeParseJson(pf.positions_json, []);
  const totalAssets     = parseFloat(pf.total_assets ?? 0);
  const held            = positions.find(p => (p.name || p.asset_name) === sorted[0].asset_name);
  const holdingRatioPct = (held && totalAssets > 0) ? parseFloat(held.market_value || 0) / totalAssets * 100 : 0;
  if (holdingRatioPct >= W.OBSERVATION_MAX_HOLDING_RATIO_PCT)
    return { ok: false, reason: `${sorted[0].asset_name}の保有比率が上限到達(${holdingRatioPct.toFixed(1)}%)` };

  const amount = Math.round(
    Math.max(W.OBSERVATION_MIN_AMOUNT, Math.min(W.OBSERVATION_MAX_AMOUNT, cash * 0.05)) / 10000
  ) * 10000;

  return { ok: true, cashRatio, amount, pf, mkt, candidates };
}

// 秘書室長タイブレーク: 4部署の投票がACCUMULATE:2/WAIT:2の同票になった場合のみ適用し、
// 通常の加重多数決（Step1の正規化スコア判定）を終了して秘書室長が最終裁定する。
// 3対1・4対0等の同票以外はnullを返して対象外とする。
// HARD RULE（システム異常・監査エラー・portfolio_status異常・データ取得失敗・重大リスク
// イベント）を検知した場合はタイブレークを実施せずWAITを返す。
async function evaluateSecretaryTieBreak(date, votes) {
  const signalCounts = {};
  for (const v of votes) {
    const s = (v.signal ?? '').toUpperCase();
    signalCounts[s] = (signalCounts[s] || 0) + 1;
  }
  const isTied = votes.length === 4 && signalCounts.ACCUMULATE === 2 && signalCounts.WAIT === 2;
  if (!isTied) return null;

  console.log('[Decision]');
  console.log('Department Vote');
  console.log(`ACCUMULATE : ${signalCounts.ACCUMULATE}`);
  console.log(`WAIT : ${signalCounts.WAIT}`);
  console.log('Tie Break');

  const fail = (label, ...reasonLines) => {
    console.log(`Secretary Decision : WAIT`);
    console.log('Reason');
    reasonLines.forEach(line => console.log(line));
    console.log('Result : WAIT');
    return {
      decision: 'WAIT',
      note: `部署投票は2対2で同票となりましたが、${label}ため秘書室長タイブレークを適用せずWAITと判断しました。`,
    };
  };

  const hardIssue = detectHardIssue(votes);
  if (hardIssue) return fail('HARD RULE（システム異常/エラー）を検知した', `HARD RULE: ${hardIssue.department}でシステム異常/エラーを検知`);

  const [pf, mkt] = await Promise.all([
    sheets.getLatestRowAsOf('portfolio_status', date).catch(() => null),
    sheets.getLatestRowAsOf('market_data', date).catch(() => null),
  ]);
  if (!pf)  return fail('HARD RULE（portfolio_status取得不可）に該当した', 'HARD RULE: portfolio_status取得不可');
  if (!mkt) return fail('HARD RULE（市場データ取得不可）に該当した', 'HARD RULE: 市場データ取得不可');

  const cashRatio = parseFloat(pf.cash_ratio ?? 0);
  const vix       = parseFloat(mkt.vix ?? 0);
  const nasdaq    = parseFloat(mkt.nasdaq100 ?? 0);
  const fg        = parseFloat(mkt.fear_greed ?? 50);

  // 重大リスクイベント判定はOBSERVATION_MAX_VIX/OBSERVATION_MAX_NASDAQ_DROP_PCTを流用
  // （risk.jsの高リスク基準と同水準に揃えるため。config/decisionWeights.js参照）
  if (vix >= W.OBSERVATION_MAX_VIX || (nasdaq <= W.OBSERVATION_MAX_NASDAQ_DROP_PCT && vix >= 25)) {
    return fail('HARD RULE（重大リスクイベント）を検知した', `HARD RULE: 重大リスクイベント（VIX${vix} NASDAQ前日比${nasdaq}%）`);
  }

  const candidates = await sheets.getRowsByDate('candidate_assets', date).catch(() => []);
  const sorted     = [...candidates].sort((a, b) => (parseInt(a.rank) || 99) - (parseInt(b.rank) || 99));
  const top        = sorted[0];
  const ruleScore  = top ? parseFloat(top.score ?? 0) : null;

  const meetsFg   = fg <= W.TIEBREAK_MAX_FEAR_GREED;
  const meetsRule = ruleScore !== null && ruleScore >= W.TIEBREAK_MIN_RULE_SCORE;
  const meetsCash = cashRatio >= W.TIEBREAK_MIN_CASH_RATIO_PCT;
  const ok        = meetsFg && meetsRule && meetsCash;

  const decision = ok ? 'ACCUMULATE' : 'WAIT';
  console.log(`Secretary Decision : ${decision}`);
  console.log('Reason');
  console.log(`Fear & Greed : ${fg}`);
  console.log(`Rule Score : ${ruleScore !== null ? ruleScore.toFixed(2) : 'N/A'}`);
  console.log(`Cash Ratio : ${cashRatio.toFixed(1)}%`);
  if (!ok) {
    const unmet = [];
    if (!meetsFg)   unmet.push(`Fear&Greed${fg}が上限${W.TIEBREAK_MAX_FEAR_GREED}超`);
    if (!meetsRule) unmet.push(`Rule Score${ruleScore !== null ? ruleScore.toFixed(2) : 'N/A'}が下限${W.TIEBREAK_MIN_RULE_SCORE}未満`);
    if (!meetsCash) unmet.push(`現金比率${cashRatio.toFixed(1)}%が下限${W.TIEBREAK_MIN_CASH_RATIO_PCT}%未満`);
    console.log(`条件未達: ${unmet.join(' / ')}`);
  }
  console.log(`Result : ${ok ? 'Observation Position' : 'WAIT'}`);

  return {
    decision, cashRatio, fg, ruleScore, pf, mkt, candidates,
    note: ok
      ? '部署投票は2対2で同票となりました。秘書室長タイブレークルールを適用し、Fear & Greed・Rule Engine評価・現金比率を総合判断した結果、観測ポジション構築と判断しました。'
      : '部署投票は2対2で同票となりましたが、秘書室長タイブレークの条件（Fear & Greed・Rule Engine評価・現金比率）を満たさなかったため、WAITと判断しました。',
  };
}

// agent_recommendationsの資産名（短名/フルネームどちらでも可）とcandidate_assetsの
// 短名・フルネームを双方向の部分一致で照合する。
// 例1: "ゴールド（SBI・iシェアーズ・ゴールドファンド）" → 短名"ゴールド"に一致（recがcandを含む）
// 例2: "全世界半導体株インデックス" → フルネーム"iFreeNEXT 全世界半導体株インデックス"に一致（candがrecを含む）
function matchesOne(recAssetName, candName) {
  if (!candName) return false;
  return recAssetName === candName ||
         recAssetName.includes(candName) ||
         candName.includes(recAssetName);
}

function matchAsset(recAssetName, candidate) {
  if (!recAssetName || recAssetName === 'なし') return false;
  return matchesOne(recAssetName, candidate.asset_name) ||
         matchesOne(recAssetName, candidate.full_name);
}

async function run(date) {
  date = date ?? todayJST();

  const votes = await sheets.getRowsByDate('agent_votes', date);

  if (votes.length === 0) {
    const result = { date, final_signal: 'WAIT', target_asset: '', amount: '', reason: '投票なし（エージェント未実行）' };
    await sheets.upsertRow('final_decisions', ['date'], result);
    return result;
  }

  // ── Step 1: 加重スコア計算でシグナル決定 ──────────────────────
  let weightedSum = 0;
  let totalConf   = 0;

  for (const v of votes) {
    const signal     = (v.signal ?? '').toUpperCase();
    const confidence = parseFloat(v.confidence) || 50;
    const w          = SIGNAL_WEIGHT[signal] ?? 0;
    weightedSum += w * (confidence / 100);
    totalConf   += confidence / 100;
  }

  const normalizedScore = totalConf > 0 ? weightedSum / totalConf : 0;

  let final_signal;
  if      (normalizedScore >= 1.5)  final_signal = 'BUY';
  else if (normalizedScore >= 0.5)  final_signal = 'ACCUMULATE';
  else if (normalizedScore >= -0.3) final_signal = 'WAIT';
  else if (normalizedScore >= -1.0) final_signal = 'DEFEND';
  else                               final_signal = 'SELL';

  // ── Step 1.4: 秘書室長タイブレーク（ACCUMULATE:2/WAIT:2の同票時のみ）────
  // 通常の加重多数決（正規化スコア）を終了し、上のfinal_signalを裁定結果で上書きする。
  // 3対1・4対0等の同票以外はnullが返り、final_signalは変更しない。
  let tieBreakCache = null; // 裁定でACCUMULATEになった場合のpf/mkt/candidatesをStep2で再利用
  let tieBreakNote  = '';
  let waitReasonOverride = '';
  const tieBreakResult = await evaluateSecretaryTieBreak(date, votes);
  if (tieBreakResult) {
    final_signal = tieBreakResult.decision;
    if (tieBreakResult.decision === 'ACCUMULATE') {
      tieBreakCache = tieBreakResult;
      tieBreakNote  = tieBreakResult.note;
    } else {
      waitReasonOverride = tieBreakResult.note;
    }
  }

  // ── Step 1.5: WAIT見送り防止（観測ポジション構築への切替判定）─────
  // 現金比率70%以上・投資可能資金あり・Rule Engine上位候補が僅差・重大リスクなし・
  // Fear&GreedがExtreme Greedでない、を全て満たす場合のみWAIT→ACCUMULATEへ切り替える。
  // HARD RULE（システム異常・監査エラー・portfolio_status異常・データ取得失敗）は現状維持。
  let observation  = null; // 判定に使ったpf/mkt/candidatesをキャッシュしStep2での再取得を避ける
  let overrideNote = '';
  if (final_signal === 'WAIT') {
    const evalResult = await evaluateObservationOverride(date, votes);
    if (evalResult.ok) {
      final_signal  = 'ACCUMULATE';
      observation   = evalResult;
      overrideNote  = `現金比率${evalResult.cashRatio.toFixed(1)}%と資金余力があり重大なリスクも検知されなかったため、様子見ではなく小さな観測ポジションを構築しました。`;
      console.log(`[signalAggregator] WAIT見送り防止: 観測ポジション構築へ切替（現金比率${evalResult.cashRatio.toFixed(1)}%）`);
    } else {
      console.log(`[signalAggregator] WAIT維持: ${evalResult.reason}`);
    }
  }

  // ── Step 2: 銘柄選択（BUY/ACCUMULATE時のみ）────────────────────
  let target_asset  = '';
  let amount        = '';
  let assetReason   = ''; // 銘柄選定の説明可能性（Explainability）テキスト

  if (['BUY', 'ACCUMULATE'].includes(final_signal)) {
    try {
      const cooldownStart = addDays(date, -W.RECENT_PURCHASE_COOLDOWN_DAYS);
      const cooldownEnd   = addDays(date, -1);
      // ④ 採用履歴補正: LOOKBACK_DECISIONS「営業日」分のfinal_decisionsを拾うため、
      // 土日・祝日で判断が飛ぶ分も見込んでカレンダー日数は3倍の幅を取る
      // （実際に集計へ使うのは直近LOOKBACK_DECISIONS件のみ。下のrecentTargets参照）。
      const balanceStart = addDays(date, -(CP.LOOKBACK_DECISIONS * 3));
      const balanceEnd    = addDays(date, -1);

      // observation（WAIT見送り防止）またはtieBreakCache（タイブレーク）があれば
      // 評価済みのpf/mkt/candidatesを再利用し、Sheets再取得を避ける
      const reuseData = observation || tieBreakCache;
      const [candidates, recs, pf, mkt, recentOrders, recentDecisions] = await Promise.all([
        reuseData ? Promise.resolve(reuseData.candidates) : sheets.getRowsByDate('candidate_assets', date),
        sheets.getRowsByDate('agent_recommendations', date)
          .then(r => r.length > 0 ? r : sheets.getRowsByDate('department_recommendations', date))
          .catch(() => []),
        reuseData ? Promise.resolve(reuseData.pf)  : sheets.getLatestRowAsOf('portfolio_status', date).catch(() => null),
        reuseData ? Promise.resolve(reuseData.mkt) : sheets.getLatestRowAsOf('market_data', date).catch(() => null),
        sheets.getRowsByDateRange('orders', cooldownStart, cooldownEnd).catch(() => []),
        sheets.getRowsByDateRange('final_decisions', balanceStart, balanceEnd).catch(() => []),
      ]);

      // ④ 採用履歴補正: 直近CP.LOOKBACK_DECISIONS件（BUY/ACCUMULATEでtarget_assetが
      // 決定した回のみ）を新しい順に並べる。WAIT/DEFEND/SELLや銘柄未決定の日は対象外。
      const recentTargets = recentDecisions
        .filter(d => d.target_asset && d.target_asset !== '')
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .slice(0, CP.LOOKBACK_DECISIONS)
        .map(d => d.target_asset);

      // 全部署の投票内訳（見送りも含めてデバッグログ用に記録。reasonには含めない）
      const deptChoices = recs.map(r => {
        const person = DEPT_PERSON[r.department] || r.agent_name || r.department;
        const asset  = r.asset_name && r.asset_name !== 'なし' ? r.asset_name : '見送り';
        return `${person}→${asset}`;
      }).join(' / ');
      console.log(`[signalAggregator] 部署投票内訳: ${deptChoices}`);

      if (candidates.length === 0) {
        // candidatesが空なら判定不能 → fallback
        console.warn('[signalAggregator] candidate_assets が空');
        assetReason = '買付候補データが取得できなかったため銘柄選定を見送りました。';
      } else {
        const maxRank      = candidates.length;
        const totalAssets  = pf ? parseFloat(pf.total_assets ?? 0) : 0;
        const positions    = pf ? safeParseJson(pf.positions_json, []) : [];

        // Rule Engineの発言力を市場状況で調整（VIXが高い＝不確実性が高いほど弱める）。
        // Fear & Greedは市場心理を表す一つの評価項目であり、Rule Engine補正の方向・強度を
        // 左右する指標としては使わない（総合評価原則：単一指標が結論を支配しない）。
        const vix       = mkt ? parseFloat(mkt.vix ?? 20) : 20;
        const vixDamp      = vix >= 30 ? W.RULE_ENGINE_VIX_DAMP.high
                          : vix >= 20 ? W.RULE_ENGINE_VIX_DAMP.elevated
                          : W.RULE_ENGINE_VIX_DAMP.normal;

        // 有効な部署推薦（買い方向・資産・金額が具体的なもの）
        // action/recommendation_typeがBUY/ACCUMULATE以外（REDUCE/SELL/REBALANCE等）は
        // 売り方向の金額を買い候補スコアに混入させないため除外する
        const BUY_ACTIONS = new Set(['BUY', 'ACCUMULATE']);
        const validRecs = recs.filter(r => {
          const action = (r.recommendation_type || r.action || '').toUpperCase();
          return BUY_ACTIONS.has(action) &&
            r.asset_name && r.asset_name !== 'なし' && parseInt(r.amount || 0) > 0;
        });
        // 信頼度加重の合計（voteScoreの正規化に使用。頭数ではなく信頼度で重み付けする）
        const totalConfWeight = validRecs.reduce((s, r) => s + (parseFloat(r.confidence) || 50) / 100, 0) || 1;

        // 各候補銘柄の combined score を計算：
        //   voteScore（部署支持率×信頼度）を基礎スコアとし、Rule Engine・保有比率・目標配分・
        //   直近買付履歴は ±config/decisionWeights.jsの範囲でしか動かせない「補正」として加える。
        //   → 部署の議論が最終判断の中心であり、客観指標・ポートフォリオ状況は僅差のケースのみを左右する。
        const scored = candidates.map(c => {
          const rank      = parseInt(c.rank) || maxRank;
          const rankScore = (maxRank - rank + 1) / maxRank;  // rank1=1.0, rank9=0.111

          const matchedRecs = validRecs.filter(r => matchAsset(r.asset_name, c));
          const voteScore   = matchedRecs.reduce((s, r) => s + (parseFloat(r.confidence) || 50) / 100, 0) / totalConfWeight;

          const ruleAdjust = (rankScore - 0.5) * 2 * W.RULE_ENGINE_MAX_ADJUST * vixDamp;

          // ① 保有比率: 保有比率(0〜100%)に比例して連続的に減点する
          const held = positions.find(p => (p.name || p.asset_name) === c.asset_name);
          const holdingRatioPct = (held && totalAssets > 0)
            ? parseFloat(held.market_value || 0) / totalAssets * 100
            : 0;
          const holdingRatioAdjust = -(Math.min(holdingRatioPct, 100) / 100) * W.HOLDING_RATIO_MAX_PENALTY;

          // ② 目標資産配分: 投資中資金(invested)に占める現在比率と目標配分の乖離
          //    不足（現在<目標）なら加点、超過（現在>目標）なら減点
          const investedTotal = pf ? parseFloat(pf.invested ?? 0) : 0;
          const currentAllocPct = (held && investedTotal > 0)
            ? parseFloat(held.market_value || 0) / investedTotal * 100
            : 0;
          const targetAllocPct  = TARGET_ALLOCATION[c.asset_name] ?? 0;
          const allocationGapPct = targetAllocPct - currentAllocPct; // +なら不足、-なら超過
          const allocationAdjust = Math.max(-1, Math.min(1, allocationGapPct / 100)) * W.TARGET_ALLOCATION_MAX_ADJUST;

          // ③ 直近買付履歴: COOLDOWN_DAYS以内の購入があれば減点（購入直後ほど強く、線形に減衰）。
          //    ただしRule Engineが「今日の理論上限」に対して強いシグナルを出している場合は無効化。
          const lastOrder = recentOrders
            .filter(o => o.asset_name === c.asset_name)
            .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
          let cooldownAdjust = 0;
          if (lastOrder) {
            const daysSince = daysBetween(lastOrder.date, date);
            if (daysSince >= 0 && daysSince < W.RECENT_PURCHASE_COOLDOWN_DAYS) {
              const decay = 1 - daysSince / W.RECENT_PURCHASE_COOLDOWN_DAYS;
              cooldownAdjust = -decay * W.RECENT_PURCHASE_MAX_PENALTY;
              const todayMaxRuleAdjust = W.RULE_ENGINE_MAX_ADJUST * vixDamp;
              const ruleStrength = todayMaxRuleAdjust > 0 ? Math.max(0, ruleAdjust) / todayMaxRuleAdjust : 0;
              if (ruleStrength >= W.RECENT_PURCHASE_OVERRIDE_RULE_RATIO) cooldownAdjust = 0;
            }
          }

          const orderAssist = rank === 1 ? W.RANK_ORDER_ASSIST : 0;

          // ④ 資産カテゴリ補正: Core資産（オルカン・S&P500）への僅かな後押し。
          //    長期資産形成の観点から、僅差の場合にCore資産が選ばれやすくする。
          //    config/categoryBonus.js で設定（日経平均は意図的に対象外。同ファイル参照）。
          const categoryAdjust = CB.CORE_ASSETS.includes(c.asset_name) ? CB.CORE_BONUS : 0;

          // ⑤ 採用履歴補正: 直近CP.LOOKBACK_DECISIONS件のfinal_decisionsで同一銘柄が
          //    繰り返し採用されているほど軽く減点する（採用回数に比例、線形）。
          //    MIN_OCCURRENCES未満（＝1回程度）は自然な選択として補正しない。
          //    禁止ではなく、他候補との差が僅差の場合のみ結果を左右する弱い補正にする。
          const balanceOccurrences = recentTargets.filter(a => a === c.asset_name).length;
          const balanceAdjust = balanceOccurrences >= CP.MIN_OCCURRENCES
            ? -(balanceOccurrences / CP.LOOKBACK_DECISIONS) * CP.MAX_PENALTY
            : 0;

          const combined = voteScore * W.DEPT_BASE_WEIGHT + ruleAdjust
            + holdingRatioAdjust + allocationAdjust + cooldownAdjust + orderAssist + categoryAdjust + balanceAdjust;

          return {
            asset_name: c.asset_name,
            combined, rankScore, voteScore, ruleAdjust,
            holdingRatioAdjust, holdingRatioPct, allocationAdjust, targetAllocPct, currentAllocPct,
            cooldownAdjust, orderAssist, categoryAdjust, balanceAdjust, balanceOccurrences,
            deptCount:      matchedRecs.length,
            matchedAmounts: matchedRecs.map(r => parseInt(r.amount || 0)),
          };
        });

        // ④⑤ カテゴリ・採用履歴補正のログ（透明性確保: 補正が適用された銘柄のみ出力）
        scored
          .filter(s => s.categoryAdjust !== 0)
          .forEach(s => {
            console.log(`[signalAggregator] Category Bonus: ${s.asset_name} +${s.categoryAdjust.toFixed(3)}（Core資産）`);
          });
        scored
          .filter(s => s.balanceAdjust !== 0)
          .forEach(s => {
            console.log(`[signalAggregator] Candidate Balance: ${s.asset_name} ${s.balanceAdjust.toFixed(3)} `
              + `（理由: 直近${CP.LOOKBACK_DECISIONS}営業日中${s.balanceOccurrences}回採用）`);
          });

        scored.sort((a, b) => b.combined - a.combined);
        const winner   = scored[0];
        const runnerUp = scored[1];
        target_asset   = winner.asset_name;

        // ログ出力（上位3件）
        const top3 = scored.slice(0, 3)
          .map(s => `${s.asset_name}(combined=${s.combined.toFixed(3)} vote=${s.voteScore.toFixed(3)} rule=${s.ruleAdjust>=0?'+':''}${s.ruleAdjust.toFixed(3)} hold=${s.holdingRatioAdjust.toFixed(3)} alloc=${s.allocationAdjust>=0?'+':''}${s.allocationAdjust.toFixed(3)}(目標${s.targetAllocPct}%/現在${s.currentAllocPct.toFixed(1)}%) cooldown=${s.cooldownAdjust.toFixed(3)} order=+${s.orderAssist.toFixed(3)} category=+${s.categoryAdjust.toFixed(3)} balance=${s.balanceAdjust.toFixed(3)}(${s.balanceOccurrences}/${CP.LOOKBACK_DECISIONS}) n=${s.deptCount})`)
          .join(' / ');
        console.log(`[signalAggregator] 銘柄スコア上位3: ${top3} (VIX減衰=${vixDamp})`);

        // 説明可能性（Explainability）: 読者向けに内部スコア・信頼度・部署一覧などの
        // デバッグ情報を含めず、平易な日本語で理由を1〜2文にまとめる。
        // 詳細な内訳（deptChoices・スコア）は上のconsole.logにのみ残す（監査・デバッグ用）。
        const distinctAssets = new Set(validRecs.map(r => {
          const m = candidates.find(c => matchAsset(r.asset_name, c));
          return m ? m.asset_name : r.asset_name;
        }));

        if (validRecs.length === 0) {
          assetReason = `部署からの具体的な銘柄推薦がなかったため、Rule Engineの評価をもとに${winner.asset_name}を採用しました。`;
        } else if (distinctAssets.size <= 1) {
          assetReason = `部署間の意見は${winner.asset_name}で一致し、${winner.asset_name}を採用しました。`;
        } else {
          const voteLeader = [...scored].sort((a, b) => b.voteScore - a.voteScore)[0];
          const sameWinner = voteLeader.asset_name === winner.asset_name;
          const others     = [...distinctAssets].filter(a => a !== winner.asset_name).join('・');
          if (sameWinner) {
            assetReason = `${winner.asset_name}と${others}で意見が分かれましたが、部署支持率・Rule Engine評価・ポートフォリオ全体のバランスを総合し、${winner.asset_name}を採用しました。`;
          } else {
            assetReason = `部署の支持率では${voteLeader.asset_name}が優勢でしたが、Rule Engineの評価や保有状況・資産配分バランスを踏まえ${winner.asset_name}を採用しました。`;
          }
        }

        // 金額: WAIT見送り防止による観測ポジションなら30〜50万円のレンジで固定額。
        // それ以外は勝利銘柄を推薦した部署の平均額（推薦なければ cash×3%）
        if (observation) {
          amount = String(observation.amount);
          console.log(`[signalAggregator] 金額: 観測ポジション ¥${observation.amount.toLocaleString()}（WAIT見送り防止）`);
        } else if (winner.matchedAmounts.length > 0) {
          const avg = winner.matchedAmounts.reduce((s, a) => s + a, 0) / winner.matchedAmounts.length;
          amount = String(Math.round(avg / 1000) * 1000);
          console.log(`[signalAggregator] 金額: 推薦平均 ¥${parseInt(amount).toLocaleString()} (${winner.matchedAmounts.map(a=>'¥'+a.toLocaleString()).join('+')})`);
        } else {
          // fallback: cash × 3%
          const cash = pf ? parseFloat(pf.cash ?? 0) : 0;
          if (pf) {
            amount = String(Math.round(cash * 0.03 / 1000) * 1000);
            console.log(`[signalAggregator] 金額: cash×3% ¥${parseInt(amount).toLocaleString()} (部署推薦なし)`);
          }
        }

        if (observation) {
          assetReason = `${assetReason} ${overrideNote}`.trim();
        } else if (tieBreakCache) {
          assetReason = `${assetReason} ${tieBreakNote}`.trim();
        }
      }
    } catch (e) {
      console.warn(`[signalAggregator] 銘柄選択エラー: ${e.message}`);
      assetReason = '銘柄選定処理で問題が発生したため、規則エンジンの結果を優先しました。';
    }
  }

  // reasonは記事にそのまま表示されるため、内部スコア・信頼度・部署一覧などのデバッグ情報を
  // 含めない平易な日本語のみとする（詳細な内訳はconsole.logの銘柄スコア上位3行に残す）。
  const signalReason = waitReasonOverride || `各部署の投票を総合し、${SIGNAL_LABEL_JA[final_signal] || final_signal}と判断しました。`;
  const reason        = assetReason || signalReason;

  const result = { date, final_signal, target_asset, amount, reason };
  await sheets.upsertRow('final_decisions', ['date'], result);

  console.log(`[signalAggregator] ${date} → ${final_signal} (score=${normalizedScore.toFixed(3)}) target=${target_asset} amount=${amount}`);
  return result;
}

module.exports = { run };
