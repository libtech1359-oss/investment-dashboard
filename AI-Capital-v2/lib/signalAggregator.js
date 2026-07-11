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
 * 銘柄選択ロジック（combined scoring）:
 *   candidateScore（逆張りスコア）× 0.5 ＋ deptScore（推薦部署数比率）× 0.5
 *   → 部署の推薦と候補ランクの両方を反映する
 *
 * 金額決定:
 *   勝利銘柄を推薦した部署の平均額（推薦なし時は cash × 3%）
 */

const sheets = require('./sheets');

const SIGNAL_WEIGHT = { BUY: 2.0, ACCUMULATE: 1.0, WAIT: 0.0, DEFEND: -1.0, SELL: -2.0 };

function todayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

// agent_recommendationsの資産名（フルネーム可）とcandidate_assetsの短名を照合
// 例: "ゴールド（SBI・iシェアーズ・ゴールドファンド）" → "ゴールド" に一致
function matchAsset(recAssetName, candidateShortName) {
  if (!recAssetName || recAssetName === 'なし') return false;
  return recAssetName === candidateShortName ||
         recAssetName.startsWith(candidateShortName) ||
         recAssetName.includes(candidateShortName);
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
  let target_asset = '';
  let amount       = '';

  if (['BUY', 'ACCUMULATE'].includes(final_signal)) {
    try {
      const [candidates, recs] = await Promise.all([
        sheets.getRowsByDate('candidate_assets', date),
        sheets.getRowsByDate('agent_recommendations', date)
          .then(r => r.length > 0 ? r : sheets.getRowsByDate('department_recommendations', date))
          .catch(() => []),
      ]);

      if (candidates.length === 0) {
        // candidatesが空なら判定不能 → fallback
        console.warn('[signalAggregator] candidate_assets が空');
      } else {
        const maxRank = candidates.length;

        // 有効な部署推薦（資産・金額が具体的なもの）
        const validRecs = recs.filter(r =>
          r.asset_name && r.asset_name !== 'なし' && parseInt(r.amount || 0) > 0
        );
        const totalValidRecs = Math.max(validRecs.length, 1);

        // 各候補銘柄の combined score を計算
        const scored = candidates.map(c => {
          const rank          = parseInt(c.rank) || maxRank;
          const candidateScore = (maxRank - rank + 1) / maxRank;  // rank1=1.0, rank9=0.111

          // この銘柄を推薦した部署数
          const matchedRecs = validRecs.filter(r => matchAsset(r.asset_name, c.asset_name));
          const deptScore   = matchedRecs.length / totalValidRecs;

          const combined = candidateScore * 0.5 + deptScore * 0.5;

          return {
            asset_name:    c.asset_name,
            combined,
            candidateScore,
            deptScore,
            deptCount:     matchedRecs.length,
            matchedAmounts: matchedRecs.map(r => parseInt(r.amount || 0)),
          };
        });

        scored.sort((a, b) => b.combined - a.combined);
        const winner = scored[0];
        target_asset = winner.asset_name;

        // ログ出力（上位3件）
        const top3 = scored.slice(0, 3)
          .map(s => `${s.asset_name}(combined=${s.combined.toFixed(3)} cand=${s.candidateScore.toFixed(3)} dept=${s.deptScore.toFixed(3)} n=${s.deptCount})`)
          .join(' / ');
        console.log(`[signalAggregator] 銘柄スコア上位3: ${top3}`);

        // 金額: 勝利銘柄を推薦した部署の平均額（推薦なければ cash×3%）
        if (winner.matchedAmounts.length > 0) {
          const avg = winner.matchedAmounts.reduce((s, a) => s + a, 0) / winner.matchedAmounts.length;
          amount = String(Math.round(avg / 1000) * 1000);
          console.log(`[signalAggregator] 金額: 推薦平均 ¥${parseInt(amount).toLocaleString()} (${winner.matchedAmounts.map(a=>'¥'+a.toLocaleString()).join('+')})`);
        } else {
          // fallback: cash × 3%
          const pf = await sheets.getLatestRow('portfolio_status').catch(() => null);
          if (pf) {
            const cash = parseFloat(pf.cash ?? 0);
            amount = String(Math.round(cash * 0.03 / 1000) * 1000);
            console.log(`[signalAggregator] 金額: cash×3% ¥${parseInt(amount).toLocaleString()} (部署推薦なし)`);
          }
        }
      }
    } catch (e) {
      console.warn(`[signalAggregator] 銘柄選択エラー: ${e.message}`);
    }
  }

  const votesSummary = votes.map(v => `${v.department}:${v.signal}(${v.confidence}%)`).join(', ');
  const reason = `機械判定 score=${normalizedScore.toFixed(3)} n=${votes.length} [${votesSummary}]`;

  const result = { date, final_signal, target_asset, amount, reason };
  await sheets.upsertRow('final_decisions', ['date'], result);

  console.log(`[signalAggregator] ${date} → ${final_signal} (score=${normalizedScore.toFixed(3)}) target=${target_asset} amount=${amount}`);
  return result;
}

module.exports = { run };
