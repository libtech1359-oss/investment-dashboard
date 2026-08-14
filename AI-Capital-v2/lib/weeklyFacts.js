'use strict';

/**
 * weeklyFacts.js — 週刊記事専用「確定値」集計層
 *
 * 週刊記事はLLMに本文から数字を拾わせて再計算させるのではなく、この層が一次データ
 * （market_data / agent_recommendations+department_recommendations / final_decisions /
 * orders / portfolio_status / capital_events / positions）から機械的に集計した確定値を
 * 渡し、LLMには「確定済みデータを文章化させる」だけにする。
 *
 * 日刊記事生成ロジック・売買ロジック・signalAggregator.js・orderManager.js・
 * final_decisions/department_recommendations の既存データには一切書き込みを行わない
 * （このファイルは読み取り専用の集計処理のみ）。
 */

const sheets        = require('./sheets');
const failArticleLog = require('./failArticleLog');

// ── 定数 ─────────────────────────────────────────────────────

const DEPT_KEY_BY_LABEL = {
  'マーケット分析部':     'market',
  'リスク管理部':         'risk',
  'ポートフォリオ管理部': 'portfolio',
  '審査部':               'audit',
};

const DEPT_KEYS = Object.values(DEPT_KEY_BY_LABEL);

const BUY_SIGNALS  = ['BUY', 'ACCUMULATE'];
const BUY_ACTIONS  = ['BUY', 'ACCUMULATE'];

// ── 丸めルール（全数値で統一。表示側はこの実数値をtoFixedするだけで、
//    集計側で別々の丸め方をしない＝「平均63.3」と「平均63」の食い違いを防止） ──
function round1(v) {
  return Math.round(v * 10) / 10;
}

// ── 汎用ヘルパー ──────────────────────────────────────────────

function toNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function statOf(rows, key) {
  const withVal = rows
    .map(r => ({ date: r.date, v: toNum(r[key]) }))
    .filter(x => x.v !== null);
  if (withVal.length === 0) return null;
  const vals = withVal.map(x => x.v);
  const min  = Math.min(...vals);
  const max  = Math.max(...vals);
  const avg  = round1(vals.reduce((a, b) => a + b, 0) / vals.length);
  const minEntry = withVal.find(x => x.v === min);
  const maxEntry = withVal.find(x => x.v === max);
  return {
    min, max, avg,
    minDate: minEntry?.date ?? null,
    maxDate: maxEntry?.date ?? null,
    count:   vals.length,
  };
}

// 日次の変化量（前日比の絶対値が最大の日）を検出する。市場データ自体が
// 「前日比%」で格納されている列（sp500/nasdaq100）と、水準値でありday-over-dayの
// 差分を取る必要がある列（fear_greed/vix）の両方に対応する。
function maxDayChange(rows, key, { asLevel } = { asLevel: true }) {
  const sorted = [...rows]
    .filter(r => r.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!asLevel) {
    // 既に前日比(%)として格納されている列 → その日そのものの絶対値が最大の日を返す
    let best = null;
    for (const r of sorted) {
      const v = toNum(r[key]);
      if (v === null) continue;
      if (!best || Math.abs(v) > Math.abs(best.delta)) best = { date: r.date, delta: v };
    }
    return best;
  }
  let best = null;
  for (let i = 1; i < sorted.length; i++) {
    const prev = toNum(sorted[i - 1][key]);
    const cur  = toNum(sorted[i][key]);
    if (prev === null || cur === null) continue;
    const delta = cur - prev;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = { date: sorted[i].date, prevDate: sorted[i - 1].date, delta, from: prev, to: cur };
    }
  }
  return best;
}

// ── 部署提案の二系統統合（① 一次データ指定：department_recommendationsを主要ソースの
//    一つとして明示的に含める。agent_recommendationsが存在すればそちらを優先し、
//    存在しない日付×部署のみdepartment_recommendationsで補完する） ───────────
function mergeRecommendations(agentRows, deptRows) {
  const key = (date, dept) => `${date}::${dept}`;
  const byKey = new Map();

  for (const r of deptRows) {
    const dept = r.department;
    if (!dept) continue;
    byKey.set(key(r.date, dept), {
      date:   r.date,
      department: dept,
      action: (r.action || 'WAIT').toUpperCase(),
      asset_name: r.asset_name || 'なし',
      amount: parseInt(r.recommended_amount || 0, 10),
      reason: r.reason || '',
      source: 'department_recommendations',
    });
  }
  // agent_recommendations が存在する日付×部署は必ずこちらで上書き（より詳細な一次データ）
  for (const r of agentRows) {
    const dept = r.department;
    if (!dept) continue;
    byKey.set(key(r.date, dept), {
      date:   r.date,
      department: dept,
      action: (r.recommendation_type || r.action || 'WAIT').toUpperCase(),
      asset_name: r.asset_name || 'なし',
      amount: parseInt(r.amount || 0, 10),
      reason: r.reason_summary || '',
      source: 'agent_recommendations',
    });
  }
  return [...byKey.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function groupByDept(recs) {
  const result = {};
  for (const k of DEPT_KEYS) result[k] = [];
  for (const r of recs) {
    const key = DEPT_KEY_BY_LABEL[r.department];
    if (key) result[key].push(r);
  }
  return result;
}

// ── 部署別: 最終判断への採用回数・推奨と最終判断の一致率・根拠の具体性 ──────
// 「勝者・反省点」は市場結果の後知恵ではなく、判断"過程"の観測可能な事実だけを根拠にする。
function computeDeptEvidence(recsByDept, decisions) {
  const decisionByDate = new Map(decisions.map(d => [d.date, d]));
  const evidence = {};

  for (const deptKey of DEPT_KEYS) {
    const recs = recsByDept[deptKey] || [];
    let adoptionCount = 0;   // その部署の提案（資産・金額・方向）がそのまま最終判断採用された回数
    let matchCount     = 0;  // 「買い方向 vs 買い方向」「WAIT方向 vs WAIT方向」で最終判断と一致した日数
    let numericReasonCount = 0; // 根拠に具体的な数値が含まれていた日数
    let flips = 0;           // 前回登場時から方向（買い/待機）が変わった回数
    let prevIsBuy = null;

    for (const r of recs) {
      const decision = decisionByDate.get(r.date);
      const isBuy = BUY_ACTIONS.includes(r.action);

      if (decision) {
        const decisionIsBuy = BUY_SIGNALS.includes((decision.final_signal || '').toUpperCase());
        if (isBuy === decisionIsBuy) matchCount++;

        if (isBuy && decisionIsBuy &&
            r.asset_name === decision.target_asset &&
            Math.abs(r.amount - parseInt(decision.amount || 0, 10)) < 1) {
          adoptionCount++;
        }
      }

      if (/\d/.test(r.reason || '')) numericReasonCount++;

      if (prevIsBuy !== null && prevIsBuy !== isBuy) flips++;
      prevIsBuy = isBuy;
    }

    evidence[deptKey] = {
      appearances:      recs.length,
      adoptionCount,
      matchCount,
      matchRate:         recs.length > 0 ? round1(matchCount / recs.length * 100) : null,
      numericReasonCount,
      numericReasonRate: recs.length > 0 ? round1(numericReasonCount / recs.length * 100) : null,
      flips,
    };
  }
  return evidence;
}

// 勝者・反省点を選出できるだけの根拠があるかを機械判定する。
// 「今週は明確な勝者を設定できません」を許容するため、恣意的に無理やり選ばない。
function evaluateWinnerLoserEligibility(deptEvidence) {
  const entries = Object.entries(deptEvidence).filter(([, e]) => e.appearances > 0);
  if (entries.length < 2) {
    return { eligible: false, reason: '提案記録のある部署が2部署未満のため比較不能' };
  }
  const adoptionVals = entries.map(([, e]) => e.adoptionCount);
  const matchVals    = entries.map(([, e]) => e.matchRate ?? 0);
  const adoptionSpread = Math.max(...adoptionVals) - Math.min(...adoptionVals);
  const matchSpread    = Math.max(...matchVals) - Math.min(...matchVals);
  if (adoptionSpread === 0 && matchSpread === 0) {
    return { eligible: false, reason: '全部署の採用回数・一致率に有意な差がないため' };
  }
  return { eligible: true, reason: null };
}

// ── 論争候補: 実際に部署間で提案（action×asset）が割れた日のうち、
//    最も割れ幅が大きかった日を1件だけ機械抽出する（無ければnull）。────────
function findDebateCandidate(recsByDate, decisionByDate) {
  let best = null;
  for (const [date, recs] of recsByDate.entries()) {
    if (recs.length < 2) continue;
    const combos = new Set(recs.map(r => `${r.action}:${r.asset_name}`));
    if (combos.size < 2) continue; // 全部署一致は論争ではない
    if (!best || combos.size > best.combos.size) {
      best = { date, recs, combos };
    }
  }
  if (!best) return null;
  const decision = decisionByDate.get(best.date) || null;
  return {
    date: best.date,
    positions: best.recs.map(r => ({
      department: r.department,
      action:     r.action,
      asset_name: r.asset_name,
      amount:     r.amount,
      reason:     r.reason,
    })),
    finalSignal: decision?.final_signal ?? null,
    finalAsset:  decision?.target_asset ?? null,
    finalAmount: decision ? parseInt(decision.amount || 0, 10) : null,
    finalReason: decision?.reason ?? null,
  };
}

// ── 今週最大の出来事: 複数カテゴリの候補を機械生成し、生成側（weekly.js）が
//    単一の指標だけで決め打ちしないよう、種類の異なる候補を横並びで返す。────
function buildBigEventCandidates({ market, decisions, orders, majorEvents, failLogsInWeek }) {
  const candidates = [];

  const fgSwing = maxDayChange(market, 'fear_greed', { asLevel: true });
  if (fgSwing) {
    candidates.push({
      type: 'fear_greed_swing',
      magnitude: Math.abs(fgSwing.delta),
      date: fgSwing.date,
      description: `${fgSwing.prevDate}→${fgSwing.date}にFear & Greedが${fgSwing.from}→${fgSwing.to}（${fgSwing.delta >= 0 ? '+' : ''}${fgSwing.delta}）に変化`,
    });
  }

  const vixSwing = maxDayChange(market, 'vix', { asLevel: true });
  if (vixSwing) {
    candidates.push({
      type: 'vix_swing',
      magnitude: Math.abs(vixSwing.delta),
      date: vixSwing.date,
      description: `${vixSwing.prevDate}→${vixSwing.date}にVIXが${vixSwing.from}→${vixSwing.to}（${vixSwing.delta >= 0 ? '+' : ''}${vixSwing.delta}）に変化`,
    });
  }

  const sp500Move = maxDayChange(market, 'sp500', { asLevel: false });
  if (sp500Move) {
    candidates.push({
      type: 'market_move',
      magnitude: Math.abs(sp500Move.delta) * 10, // 指数騰落率はF&G/VIXよりスケールが小さいため正規化
      date: sp500Move.date,
      description: `${sp500Move.date}にS&P500が前日比${sp500Move.delta >= 0 ? '+' : ''}${sp500Move.delta}%`,
    });
  }

  const nasdaqMove = maxDayChange(market, 'nasdaq100', { asLevel: false });
  if (nasdaqMove) {
    candidates.push({
      type: 'market_move',
      magnitude: Math.abs(nasdaqMove.delta) * 10,
      date: nasdaqMove.date,
      description: `${nasdaqMove.date}にNASDAQ100が前日比${nasdaqMove.delta >= 0 ? '+' : ''}${nasdaqMove.delta}%`,
    });
  }

  if (orders.length > 0) {
    const biggest = [...orders].filter(o => o.status !== 'sold').sort((a, b) => parseInt(b.amount || 0, 10) - parseInt(a.amount || 0, 10))[0];
    if (biggest) {
      candidates.push({
        type: 'biggest_investment',
        magnitude: parseInt(biggest.amount || 0, 10) / 10000, // 万円単位でスケールを揃える
        date: biggest.date,
        description: `${biggest.date}に${biggest.asset_name}へ¥${parseInt(biggest.amount || 0, 10).toLocaleString()}の買付`,
      });
    }
  }

  const sortedDecisions = [...decisions].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (let i = 1; i < sortedDecisions.length; i++) {
    const prevSig = (sortedDecisions[i - 1].final_signal || '').toUpperCase();
    const curSig  = (sortedDecisions[i].final_signal || '').toUpperCase();
    if (prevSig && curSig && prevSig !== curSig) {
      candidates.push({
        type: 'signal_change',
        magnitude: 15, // シグナル転換は市場変動と並ぶ注目度として固定重み
        date: sortedDecisions[i].date,
        description: `${sortedDecisions[i].date}に最終判断が${prevSig}から${curSig}へ転換`,
      });
    }
  }

  if (majorEvents && majorEvents.length > 0) {
    for (const e of majorEvents) {
      candidates.push({
        type: 'system_update',
        magnitude: e.impact === 'high' ? 25 : (e.impact === 'medium' ? 12 : 6),
        date: e.date,
        description: `${e.date}に運用面の改善が行われた`,
      });
    }
  }

  if (failLogsInWeek > 0) {
    candidates.push({
      type: 'validator_fail',
      magnitude: failLogsInWeek * 8,
      date: null,
      description: `週内に記事チェックで${failLogsInWeek}件の要修正が検出された`,
    });
  }

  candidates.sort((a, b) => b.magnitude - a.magnitude);
  return candidates;
}

// ── メイン集計 ────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array} opts.market            market_data（週内・日付昇順）
 * @param {Array} opts.agentRecs         agent_recommendations（週内）
 * @param {Array} opts.deptRecs          department_recommendations（週内）
 * @param {Array} opts.decisions         final_decisions（週内）
 * @param {Array} opts.orders            orders（週内）
 * @param {object|null} opts.portfolio   portfolio_status 週末時点
 * @param {object|null} opts.portfolioPrev portfolio_status 前週末時点
 * @param {Array} opts.capitalEventsInWeek capital_events（週内発生分）
 * @param {Array} opts.majorEvents       development_logs 由来の重大イベント（週内）
 * @param {string} opts.startDate
 * @param {string} opts.endDate
 * @returns {object} facts
 */
function buildWeeklyFacts(opts) {
  const {
    market, agentRecs, deptRecs, decisions, orders,
    portfolio, portfolioPrev, capitalEventsInWeek, majorEvents,
    startDate, endDate,
  } = opts;

  // ── 投資回数・WAIT回数・銘柄別集計（final_decisionsを正本とする） ──────
  const accumulateCount = decisions.filter(d => (d.final_signal || '').toUpperCase() === 'ACCUMULATE').length;
  const buySignalCount  = decisions.filter(d => BUY_SIGNALS.includes((d.final_signal || '').toUpperCase())).length;
  const waitCount        = decisions.filter(d => (d.final_signal || '').toUpperCase() === 'WAIT').length;

  // ── 総投資額（実際に発生した買付注文の合計。売却注文(status=sold)は除外） ──
  const buyOrders     = orders.filter(o => o.status !== 'sold');
  const totalInvested = buyOrders.reduce((s, o) => s + parseInt(o.amount || 0, 10), 0);

  const assetOrderCounts = {};
  for (const o of buyOrders) {
    const name = o.asset_name || '不明';
    assetOrderCounts[name] = (assetOrderCounts[name] || 0) + 1;
  }

  // final_decisions側の合計（orders側と突き合わせ、乖離があれば記事へは出さず内部フラグにする）
  const totalFromDecisions = decisions
    .filter(d => BUY_SIGNALS.includes((d.final_signal || '').toUpperCase()))
    .reduce((s, d) => s + parseInt(d.amount || 0, 10), 0);
  const investedAmountConsistent = Math.abs(totalInvested - totalFromDecisions) < 1000;

  // ── 市場データ平均値（丸めルール統一） ──────────────────────────
  const marketStats = {
    fear_greed: statOf(market, 'fear_greed'),
    vix:        statOf(market, 'vix'),
    usdjpy:     statOf(market, 'usdjpy'),
    sp500:      statOf(market, 'sp500'),
    nasdaq100:  statOf(market, 'nasdaq100'),
  };

  // ── 部署別提案の統合・集計 ────────────────────────────────────
  const recs       = mergeRecommendations(agentRecs, deptRecs);
  const recsByDept = groupByDept(recs);
  const recsByDate = new Map();
  for (const r of recs) {
    if (!recsByDate.has(r.date)) recsByDate.set(r.date, []);
    recsByDate.get(r.date).push(r);
  }
  const deptAdoptionCounts = {};
  for (const k of DEPT_KEYS) deptAdoptionCounts[k] = 0;

  const decisionByDate = new Map(decisions.map(d => [d.date, d]));
  for (const [date, dayRecs] of recsByDate.entries()) {
    const decision = decisionByDate.get(date);
    if (!decision || !BUY_SIGNALS.includes((decision.final_signal || '').toUpperCase())) continue;
    const matched = dayRecs.find(r =>
      BUY_ACTIONS.includes(r.action) &&
      r.asset_name === decision.target_asset &&
      Math.abs(r.amount - parseInt(decision.amount || 0, 10)) < 1
    );
    if (matched) {
      const deptKey = DEPT_KEY_BY_LABEL[matched.department];
      if (deptKey) deptAdoptionCounts[deptKey]++;
    }
  }

  const deptEvidence     = computeDeptEvidence(recsByDept, decisions);
  const winnerLoserCheck = evaluateWinnerLoserEligibility(deptEvidence);

  const debateCandidate = findDebateCandidate(recsByDate, decisionByDate);

  // ── ポートフォリオ前週比（機械計算のみ。current - previous 以外の値は使わない） ──
  let portfolioChange = null;
  if (portfolio) {
    const curTotal = parseInt(portfolio.total_assets || 0, 10);
    const curCash  = parseFloat(portfolio.cash_ratio || 0);
    const curPl    = parseInt(portfolio.unrealized_pl || 0, 10);
    const curInv   = parseInt(portfolio.invested || 0, 10);

    if (portfolioPrev) {
      const prevTotal = parseInt(portfolioPrev.total_assets || 0, 10);
      const prevCash  = parseFloat(portfolioPrev.cash_ratio || 0);
      const prevPl    = parseInt(portfolioPrev.unrealized_pl || 0, 10);
      const prevInv   = parseInt(portfolioPrev.invested || 0, 10);

      const injectedThisWeek = (capitalEventsInWeek || [])
        .reduce((s, e) => s + parseInt(e.amount || 0, 10), 0);

      portfolioChange = {
        computable:        true,
        totalDiff:          curTotal - prevTotal,
        cashRatioDiff:      round1(curCash - prevCash),
        unrealizedPlDiff:   curPl - prevPl,
        investedDiff:       curInv - prevInv,
        capitalInjectedThisWeek: injectedThisWeek,
      };
    } else {
      portfolioChange = { computable: false, reason: '前週データ未取得のため算出不可' };
    }
  }

  const failLogsInWeek = failArticleLog.readAllFailLogs()
    .filter(r => r.date >= startDate && r.date <= endDate).length;

  const bigEventCandidates = buildBigEventCandidates({
    market, decisions, orders: buyOrders, majorEvents, failLogsInWeek,
  });
  const biggestEvent = bigEventCandidates[0] || null;

  const growthEvidence = {
    hasEvidence: (majorEvents && majorEvents.length > 0),
    majorEvents: majorEvents || [],
  };

  return {
    period: { start: startDate, end: endDate, tradingDays: market.length },
    investCount:       buySignalCount,
    accumulateCount,
    waitCount,
    totalInvested,
    investedAmountConsistent,
    assetOrderCounts,
    marketStats,
    recs,
    recsByDept,
    recsByDate,
    deptAdoptionCounts,
    deptEvidence,
    winnerLoserEligible: winnerLoserCheck.eligible,
    winnerLoserIneligibleReason: winnerLoserCheck.reason,
    debateCandidate,
    portfolioChange,
    bigEventCandidates,
    biggestEvent,
    growthEvidence,
    capitalEventsInWeek: capitalEventsInWeek || [],
    failLogsInWeek,
  };
}

module.exports = {
  DEPT_KEY_BY_LABEL,
  round1,
  statOf,
  maxDayChange,
  mergeRecommendations,
  groupByDept,
  computeDeptEvidence,
  evaluateWinnerLoserEligibility,
  findDebateCandidate,
  buildBigEventCandidates,
  buildWeeklyFacts,
};
