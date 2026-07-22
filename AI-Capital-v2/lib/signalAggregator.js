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
 * 銘柄選択ロジック（部署の議論を中心に、客観指標・ポートフォリオ全体最適化は「補正」として加える構造）:
 *   voteScore（部署の信頼度加重支持率, 0〜1）を基礎スコアとし、
 *   + ruleAdjust（Rule Engine: ATH乖離ランク・Fear&Greed・VIX）
 *   + holdingRatioAdjust（① 保有比率が高いほど連続的に減点。集中投資の抑制）
 *   + allocationAdjust（② config/targetAllocation.js の目標配分との乖離。不足なら加点・超過なら減点）
 *   + cooldownAdjust（③ 直近の連続購入を減点。ただしRule Engineが強い日は無効化される）
 *   + orderAssist（規則エンジンの推奨第1候補への極小の後押し）
 *   をそれぞれ ±config/decisionWeights.js の範囲で加算する。
 *   重みは config/decisionWeights.js で管理する（コードに固定値を埋め込まない）。
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

  // ── Step 2: 銘柄選択（BUY/ACCUMULATE時のみ）────────────────────
  let target_asset  = '';
  let amount        = '';
  let assetReason   = ''; // 銘柄選定の説明可能性（Explainability）テキスト

  if (['BUY', 'ACCUMULATE'].includes(final_signal)) {
    try {
      const cooldownStart = addDays(date, -W.RECENT_PURCHASE_COOLDOWN_DAYS);
      const cooldownEnd   = addDays(date, -1);

      const [candidates, recs, pf, mkt, recentOrders] = await Promise.all([
        sheets.getRowsByDate('candidate_assets', date),
        sheets.getRowsByDate('agent_recommendations', date)
          .then(r => r.length > 0 ? r : sheets.getRowsByDate('department_recommendations', date))
          .catch(() => []),
        sheets.getLatestRowAsOf('portfolio_status', date).catch(() => null),
        sheets.getLatestRowAsOf('market_data', date).catch(() => null),
        sheets.getRowsByDateRange('orders', cooldownStart, cooldownEnd).catch(() => []),
      ]);

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

        // Rule Engineの発言力を市場状況で調整（Fear&Greedが恐怖圏に近いほど強く、VIXが高いほど弱く）
        const fearGreed = mkt ? parseFloat(mkt.fear_greed ?? 50) : 50;
        const vix       = mkt ? parseFloat(mkt.vix ?? 20) : 20;
        const fgIntensity = fearGreed <= 25 ? W.RULE_ENGINE_FG_INTENSITY.extreme
                          : fearGreed <= 45 ? W.RULE_ENGINE_FG_INTENSITY.fear
                          : W.RULE_ENGINE_FG_INTENSITY.neutral;
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

          const ruleAdjust = (rankScore - 0.5) * 2 * W.RULE_ENGINE_MAX_ADJUST * fgIntensity * vixDamp;

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
              const todayMaxRuleAdjust = W.RULE_ENGINE_MAX_ADJUST * fgIntensity * vixDamp;
              const ruleStrength = todayMaxRuleAdjust > 0 ? Math.max(0, ruleAdjust) / todayMaxRuleAdjust : 0;
              if (ruleStrength >= W.RECENT_PURCHASE_OVERRIDE_RULE_RATIO) cooldownAdjust = 0;
            }
          }

          const orderAssist = rank === 1 ? W.RANK_ORDER_ASSIST : 0;

          const combined = voteScore * W.DEPT_BASE_WEIGHT + ruleAdjust
            + holdingRatioAdjust + allocationAdjust + cooldownAdjust + orderAssist;

          return {
            asset_name: c.asset_name,
            combined, rankScore, voteScore, ruleAdjust,
            holdingRatioAdjust, holdingRatioPct, allocationAdjust, targetAllocPct, currentAllocPct,
            cooldownAdjust, orderAssist,
            deptCount:      matchedRecs.length,
            matchedAmounts: matchedRecs.map(r => parseInt(r.amount || 0)),
          };
        });

        scored.sort((a, b) => b.combined - a.combined);
        const winner   = scored[0];
        const runnerUp = scored[1];
        target_asset   = winner.asset_name;

        // ログ出力（上位3件）
        const top3 = scored.slice(0, 3)
          .map(s => `${s.asset_name}(combined=${s.combined.toFixed(3)} vote=${s.voteScore.toFixed(3)} rule=${s.ruleAdjust>=0?'+':''}${s.ruleAdjust.toFixed(3)} hold=${s.holdingRatioAdjust.toFixed(3)} alloc=${s.allocationAdjust>=0?'+':''}${s.allocationAdjust.toFixed(3)}(目標${s.targetAllocPct}%/現在${s.currentAllocPct.toFixed(1)}%) cooldown=${s.cooldownAdjust.toFixed(3)} order=+${s.orderAssist.toFixed(3)} n=${s.deptCount})`)
          .join(' / ');
        console.log(`[signalAggregator] 銘柄スコア上位3: ${top3} (FG強度=${fgIntensity} VIX減衰=${vixDamp})`);

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

        // 金額: 勝利銘柄を推薦した部署の平均額（推薦なければ cash×3%）
        if (winner.matchedAmounts.length > 0) {
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
      }
    } catch (e) {
      console.warn(`[signalAggregator] 銘柄選択エラー: ${e.message}`);
      assetReason = '銘柄選定処理で問題が発生したため、規則エンジンの結果を優先しました。';
    }
  }

  // reasonは記事にそのまま表示されるため、内部スコア・信頼度・部署一覧などのデバッグ情報を
  // 含めない平易な日本語のみとする（詳細な内訳はconsole.logの銘柄スコア上位3行に残す）。
  const signalReason = `各部署の投票を総合し、${SIGNAL_LABEL_JA[final_signal] || final_signal}と判断しました。`;
  const reason        = assetReason || signalReason;

  const result = { date, final_signal, target_asset, amount, reason };
  await sheets.upsertRow('final_decisions', ['date'], result);

  console.log(`[signalAggregator] ${date} → ${final_signal} (score=${normalizedScore.toFixed(3)}) target=${target_asset} amount=${amount}`);
  return result;
}

module.exports = { run };
