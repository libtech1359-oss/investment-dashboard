'use strict';

/**
 * config/decisionWeights.js — 最終判断ロジックの重み設定
 *
 * AI Capitalの思想: 「部署間の議論」が最終判断の中心であり、
 * Rule Engine（客観指標）とPortfolio評価は、それを補正する役割に留める。
 * signalAggregatorスコア（候補順位）は補助指標であり、単独で結論を左右してはならない。
 * 2026-07-22〜: 「一番スコアが高い銘柄を買う」のではなく「長期ポートフォリオ全体として
 * 最適な判断をする」ため、保有比率・目標資産配分・直近買付履歴も補正要素に加えた。
 *
 * 数値の調整はこのファイルでのみ行い、lib/signalAggregator.js にはハードコードしない。
 */

module.exports = {
  // 部署支持率×信頼度（voteScore, 0〜1）＝最終判断の基礎スコア。ここが決定打。
  DEPT_BASE_WEIGHT: 1.0,

  // Rule Engine（candidate_assetsの総合評価スコアランク）による補正の最大振れ幅（±）。
  // voteScore（0〜1の全域）に対してこの範囲でしか動かせないため、部署支持率の
  // 大差は覆せず、僅差・ほぼ同点のケースのみを左右する設計。
  RULE_ENGINE_MAX_ADJUST: 0.20,

  // VIXが高い（不確実性が高い）ほどRule Engineの補正を弱め、部署判断を優先する減衰係数。
  // Fear & Greedは方向性を決める指標ではなく市場心理を表す一つの評価項目として扱うため、
  // Rule Engine補正の強度には使わない（総合評価原則）。
  // high: VIX>=30 / elevated: VIX>=20 / normal: それ未満
  RULE_ENGINE_VIX_DAMP: { high: 0.5, elevated: 0.8, normal: 1.0 },

  // ① 保有比率: 対象銘柄の現在の保有比率（0〜100%、時価/総資産）が高いほど連続的に
  // 減点する（集中投資の抑制）。保有比率100%のとき最大でこの値だけ減点する。
  HOLDING_RATIO_MAX_PENALTY: 0.15,

  // ② 目標資産配分: config/targetAllocation.js との乖離を加点・減点する。
  // 目標未達（不足）なら加点、目標超過なら減点。乖離±100pt相当のときの最大振れ幅。
  TARGET_ALLOCATION_MAX_ADJUST: 0.15,

  // ③ 直近買付履歴: 短期間で同じ銘柄を連続購入した場合に減点する（過度な偏りの抑制）。
  RECENT_PURCHASE_COOLDOWN_DAYS: 5,    // この日数以内の同一銘柄購入を減点対象にする
  RECENT_PURCHASE_MAX_PENALTY: 0.15,   // 購入直後（0日後）の最大減点。COOLDOWN_DAYSにかけて線形に0へ減衰
  // その日のRule Engine評価が「今日の理論上限」に対してこの割合以上強い場合は、
  // 直近購入による減点を無効化する（強いシグナルはクールダウンを上回れる）。
  RECENT_PURCHASE_OVERRIDE_RULE_RATIO: 0.8,

  // signalAggregatorスコア（規則エンジン推奨第1候補への極小の後押し）。
  // 単独では部署支持率の差を逆転できない値に留める。
  RANK_ORDER_ASSIST: 0.05,

  // ── WAIT見送り防止・観測ポジション構築（2026-08-01〜）─────────────
  // AI Capitalは「リスクを避けるAI」ではなく「適切なリスクを取りながら長期資産形成を
  // 行うAI」を目指す。以下を全て満たす場合、final_signalがWAIT判定でも小額の観測
  // ポジション構築（ACCUMULATE）へ切り替える（lib/signalAggregator.js evaluateObservationOverride）。
  // ただしHARD RULE（システム異常・監査エラー・portfolio_status異常・データ取得失敗）は対象外。
  OBSERVATION_MIN_CASH_RATIO_PCT:  70,      // 現金比率がこの%以上のときのみ対象
  OBSERVATION_MIN_AMOUNT:          300000,  // 観測ポジションの下限額
  OBSERVATION_MAX_AMOUNT:          500000,  // 観測ポジションの上限額
  OBSERVATION_MAX_SCORE_GAP_PCT:   15,      // Rule Engine上位候補(rank1)とrank2のスコア差がこの%以内なら「僅差」
  OBSERVATION_MAX_HOLDING_RATIO_PCT: 40,    // 対象銘柄の保有比率がこれ以上なら見送り（集中抑制。risk.jsの分散基準と同水準）
  OBSERVATION_MAX_VIX:             30,      // VIXがこれ以上なら高リスク局面としてWAITを維持（risk.jsの高リスク基準と同水準）
  OBSERVATION_MAX_NASDAQ_DROP_PCT: -3,      // NASDAQ前日比がこれ以下 かつ VIX>=25 なら高リスク局面
  OBSERVATION_MAX_FEAR_GREED:      75,      // Fear&GreedがこれよりExtreme Greed（>75）ならWAITを維持

  // ── 秘書室長タイブレーク（2026-08-02〜）───────────────────────
  // 4部署の投票がACCUMULATE:2/WAIT:2の同票になった場合のみ適用。通常の加重多数決
  // （Step1の正規化スコア判定）を終了し、秘書室長が以下の条件で最終裁定する
  // （lib/signalAggregator.js evaluateSecretaryTieBreak）。3対1・4対0等の同票以外は対象外。
  // 重大リスクイベントの判定はOBSERVATION_MAX_VIX/OBSERVATION_MAX_NASDAQ_DROP_PCTを流用する
  // （risk.jsの高リスク基準と同水準に揃えるため）。
  // HARD RULE（システム異常・監査エラー・portfolio_status異常・データ取得失敗・重大リスク
  // イベント）は対象外のままタイブレークを実施せずWAITを維持する。
  TIEBREAK_MAX_FEAR_GREED:     50,   // Fear&Greedがこれ以下ならACCUMULATE方向の条件を満たす
  TIEBREAK_MIN_RULE_SCORE:     0.70, // Rule Engine上位候補(rank1)のscoreがこれ以上
  TIEBREAK_MIN_CASH_RATIO_PCT: 50,   // 現金比率がこれ以上

  // ── Observation Candidate Filter（2026-08-03〜）───────────────
  // 観測ポジションモード（WAIT見送り防止・秘書室長タイブレークでACCUMULATEになった場合）
  // でのみ適用。Rule Engine上位候補（candidate_assets.score）の差がこの値以内の場合のみ、
  // config/longTermPriority.js の優先度リストに基づいて銘柄を選び直す
  // （lib/signalAggregator.js applyObservationCandidateFilter）。差が大きい場合は
  // Rule Engine順位（最高スコア銘柄）をそのまま維持する。通常の加重多数決によるBUY/
  // ACCUMULATE（部署の議論が中心のケース）には適用しない。
  OBSERVATION_FILTER_MAX_SCORE_GAP: 0.03,
};
