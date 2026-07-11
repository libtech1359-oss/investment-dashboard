'use strict';

/**
 * weekly.js — 週刊記事エージェント
 *
 * 現時点の実装範囲:
 *   - データ取得・集計（全シート横断）
 *   - 記事テンプレート組み立て（機械生成セクション）
 *   - LLMコメントセクションはスタブ（TODO マーク付き）
 *
 * 未実装（将来: データ蓄積後に追加）:
 *   - 部署別勝率・的中率
 *   - MVP部署ランキング
 *   - 資産推移グラフ
 *   - note.com への自動保存・定期実行
 *
 * 手動実行: node _run_weekly.js YYYY-MM-DD YYYY-MM-DD
 */

const sheets = require('../lib/sheets');

// ── 定数 ─────────────────────────────────────────────────────

const INITIAL_ASSETS = 10_000_000;

// ── Week ID ───────────────────────────────────────────────────

/**
 * ISO 8601 週番号から week_id を生成する
 * 例: '2026-06-26' → '2026-W26'
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} 'YYYY-Www'
 */
function weekId(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // 最も近い木曜日を基準にする（ISO 8601 準拠）
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 週刊記事の管理メタデータを返す
 * status: 'draft' | 'reviewed' | 'published'
 * 現時点では draft のみ使用
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {object}
 */
function buildWeeklyMeta(startDate, endDate) {
  return {
    week_id:      weekId(startDate),
    start_date:   startDate,
    end_date:     endDate,
    status:       'draft',
    generated_at: null,  // 将来: 生成完了時に ISO 8601 タイムスタンプを設定
    published_at: null,  // 将来: note.com 公開後に設定
  };
}

const SIGNAL_WEIGHT = { BUY: 2, ACCUMULATE: 1, WAIT: 0, DEFEND: -1, SELL: -2 };

const DEPT_DISPLAY = {
  market:    '📈 神谷シン（マーケット分析部）',
  portfolio: '💼 橘アオイ（ポートフォリオ管理部）',
  risk:      '🛡️ 黒崎ミサキ（リスク管理部）',
  audit:     '🔍 鬼塚ガイ（審査部）',
};

// ── データ取得 ────────────────────────────────────────────────

/**
 * 指定期間のデータを全シートから収集する
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {Promise<object>}
 */
async function gatherWeeklyData(startDate, endDate) {
  const [
    marketRows,
    voteRows,
    recRows,
    decisionRows,
    orderRows,
    portfolio,
    positionRows,
  ] = await Promise.all([
    sheets.getRowsByDateRange('market_data',           startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('agent_votes',            startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('agent_recommendations',  startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('final_decisions',        startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('orders',                 startDate, endDate).catch(() => []),
    sheets.getLatestRow('portfolio_status').catch(() => null),
    sheets.getRows('positions').catch(() => []),
  ]);

  return {
    period:          { start: startDate, end: endDate, days: marketRows.length },
    market:          marketRows,
    marketSummary:   summarizeMarket(marketRows),
    decisions:       decisionRows,
    votesByDept:     aggregateVotesByDept(voteRows),
    orders:          orderRows,
    portfolio,
    positions:       positionRows,
    recommendations: {
      assets:  aggregateAssetFreq(recRows),
      signals: aggregateSignalFreq(decisionRows),
    },
    latestMarket:    marketRows[marketRows.length - 1] ?? null,
  };
}

// ── 集計ヘルパー ──────────────────────────────────────────────

function summarizeMarket(rows) {
  if (!rows.length) return null;
  const pick = key => rows.map(r => parseFloat(r[key])).filter(v => !isNaN(v));
  const stat = arr => arr.length
    ? { min: Math.min(...arr), max: Math.max(...arr), avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 }
    : null;
  return {
    fear_greed: stat(pick('fear_greed')),
    vix:        stat(pick('vix')),
    usdjpy:     stat(pick('usdjpy')),
    nasdaq100:  stat(pick('nasdaq100')),
  };
}

function aggregateVotesByDept(voteRows) {
  const result = {};
  for (const dept of Object.keys(DEPT_DISPLAY)) {
    result[dept] = Object.fromEntries(Object.keys(SIGNAL_WEIGHT).map(s => [s, 0]));
  }
  for (const row of voteRows) {
    const dept   = row.department;
    const signal = (row.signal || '').toUpperCase();
    if (result[dept] && signal in result[dept]) result[dept][signal]++;
  }
  return result;
}

function aggregateAssetFreq(recRows) {
  const freq = {};
  for (const row of recRows) {
    if (!row.asset_id || (row.signal || row.recommendation_type || '').toUpperCase() === 'WAIT') continue;
    const key = row.asset_id || row.asset_name;
    if (!key) continue;
    freq[key] = (freq[key] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]);
}

function aggregateSignalFreq(decisionRows) {
  const freq = {};
  for (const row of decisionRows) {
    const s = (row.final_signal || 'UNKNOWN').toUpperCase();
    freq[s] = (freq[s] || 0) + 1;
  }
  return freq;
}

// ── セクションビルダー ────────────────────────────────────────

/** ① 今週の結論（機械生成3行）*/
function buildConclusion(data) {
  const { decisions, orders, period, marketSummary } = data;
  const buyCount  = orders.length;
  const hasDefend = decisions.some(d => ['DEFEND', 'SELL'].includes((d.final_signal || '').toUpperCase()));
  const fgAvg     = marketSummary?.fear_greed?.avg;
  const fgDesc    = fgAvg == null ? '' : fgAvg <= 25 ? '（極端な恐怖圏）' : fgAvg <= 45 ? '（恐怖圏）' : fgAvg <= 55 ? '（中立）' : '（楽観圏）';

  return [
    `## ① 今週の結論`,
    '',
    `・今週（${period.start}〜${period.end}）は${period.days}営業日の記録${fgAvg != null ? `。市場心理平均 Fear & Greed ${fgAvg}${fgDesc}` : ''}`,
    `・観測ポジション構築 ${buyCount}回${buyCount === 0 ? '（全日見送り）' : ''}`,
    hasDefend
      ? '・防御シグナルが発生した局面あり。慎重姿勢を維持'
      : '・防御シグナルなし。逆張り観測を継続',
  ].join('\n');
}

/** ② 今週の市場まとめ */
function buildMarket(data) {
  const { marketSummary } = data;
  if (!marketSummary) return `## ② 今週の市場まとめ\n\nデータなし`;

  const fmt = stat => stat ? `${stat.min}〜${stat.max}（平均 ${stat.avg}）` : '—';

  return [
    `## ② 今週の市場まとめ`,
    '',
    `📊 Fear & Greed : ${fmt(marketSummary.fear_greed)}`,
    `⚡ VIX          : ${fmt(marketSummary.vix)}`,
    `💵 USD/JPY      : ${fmt(marketSummary.usdjpy)} 円`,
    `📈 NASDAQ100    : 前日比 ${fmt(marketSummary.nasdaq100)} %`,
    '',
    `※ 推移グラフは将来実装予定`,
  ].join('\n');
}

/** ③ 部署別判断まとめ */
function buildVotes(data) {
  const { votesByDept } = data;
  const lines = [];
  for (const [dept, counts] of Object.entries(votesByDept)) {
    const label   = DEPT_DISPLAY[dept] || dept;
    const summary = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${s}:${n}回`)
      .join(' / ');
    lines.push(`${label}\n  → ${summary || '記録なし'}`);
  }
  return [`## ③ 部署別判断まとめ`, '', ...lines].join('\n');
}

/** ④ AI Capital 運用状況 */
function buildPortfolio(data) {
  const { portfolio, positions } = data;
  if (!portfolio) return `## ④ AI Capital 運用状況\n\nデータなし`;

  const total    = parseInt(portfolio.total_assets   || 0);
  const cash     = parseInt(portfolio.cash           || 0);
  const pending  = parseInt(portfolio.pending        || 0);
  const invested = parseInt(portfolio.invested       || 0);
  const ratio    = portfolio.cash_ratio != null ? `${parseFloat(portfolio.cash_ratio).toFixed(1)}%` : '—';
  const totalPnl = total - INITIAL_ASSETS;
  const pnlSign  = totalPnl >= 0 ? '+' : '';

  const posLines = positions.length
    ? positions.map(p => `  ・${p.asset_name ?? p.asset_id} ¥${Number(p.invested_amount || 0).toLocaleString()}`).join('\n')
    : '  ・なし';

  return [
    `## ④ AI Capital 運用状況`,
    '',
    `開始資産  : ¥${INITIAL_ASSETS.toLocaleString()}`,
    `現在資産  : ¥${total.toLocaleString()}`,
    `累計損益  : ${pnlSign}¥${totalPnl.toLocaleString()}`,
    `現金比率  : ${ratio}`,
    `現金残高  : ¥${cash.toLocaleString()}`,
    `注文中    : ¥${pending.toLocaleString()}`,
    `投資中    : ¥${invested.toLocaleString()}`,
    ``,
    `保有資産:`,
    posLines,
  ].join('\n');
}

/** ⑤ 今週の売買履歴 */
function buildOrders(data) {
  const { orders } = data;
  if (!orders.length) return `## ⑤ 今週の売買履歴\n\n今週の売買なし`;

  const rows = orders.map(o =>
    `・${o.date} | ${o.asset_name} | ¥${Number(o.amount || 0).toLocaleString()} | ${o.reason_summary || '—'}`
  );
  return [`## ⑤ 今週の売買履歴`, '', ...rows].join('\n');
}

/**
 * ⑥ AI社員コメント
 * TODO: LLM実装時に各部署ごとに ask() を呼ぶ
 * 引数: weekSummary（データ集計結果を文字列化したもの）
 */
function buildComments(_data) {
  // TODO: 実装時は以下を追加
  //   const summary = buildWeekSummaryText(data);
  //   const shinComment = await ask(WEEKLY_MARKET_SYSTEM,    summary, { num_predict: 300 });
  //   const misakiComment = await ask(WEEKLY_RISK_SYSTEM,    summary, { num_predict: 300 });
  //   const aoiComment = await ask(WEEKLY_PORT_SYSTEM,       summary, { num_predict: 300 });
  //   const gaiComment = await ask(WEEKLY_AUDIT_SYSTEM,      summary, { num_predict: 300 });
  //   const reiComment = await ask(WEEKLY_SECRETARY_SYSTEM,  summary, { num_predict: 400 });

  return [
    `## ⑥ AI社員コメント`,
    '',
    `📈 神谷シン（マーケット分析部）`,
    `（将来実装: 今週の市場分析コメント）`,
    '',
    `🛡️ 黒崎ミサキ（リスク管理部）`,
    `（将来実装: 今週のリスク評価コメント）`,
    '',
    `💼 橘アオイ（ポートフォリオ管理部）`,
    `（将来実装: ポートフォリオ運用コメント）`,
    '',
    `🔍 鬼塚ガイ（審査部）`,
    `（将来実装: 今週の判断審査コメント）`,
    '',
    `👑 相沢レイ（秘書室長）`,
    `（将来実装: 週次総合所見）`,
  ].join('\n');
}

/** ⑦ AI会社の判断傾向 */
function buildTrends(data) {
  const { recommendations } = data;
  const { assets, signals } = recommendations;

  const assetLines = assets.length
    ? assets.slice(0, 5).map(([id, n]) => `  ・${id}: ${n}回推薦`)
    : ['  ・推薦データなし'];

  const signalLines = Object.keys(signals).length
    ? Object.entries(signals).map(([s, n]) => `  ・${s}: ${n}回`).join('\n')
    : '  ・データなし';

  return [
    `## ⑦ AI会社の判断傾向`,
    '',
    `**推薦された銘柄（上位5）:**`,
    ...assetLines,
    '',
    `**最終シグナル内訳:**`,
    signalLines,
    '',
    `（傾向分析コメントは将来実装: LLM生成）`,
    `（部署別勝率・的中率・ランキングはデータ蓄積後に実装予定）`,
  ].join('\n');
}

/** ⑧ 来週の注目条件（最新市場データから機械生成）*/
function buildWatchPoints(data) {
  const mkt = data.latestMarket;
  if (!mkt) return `## ⑧ 来週の注目条件\n\nデータなし`;

  const fg   = parseFloat(mkt.fear_greed ?? 50);
  const vix  = parseFloat(mkt.vix ?? 15);
  const n100 = parseFloat(mkt.nasdaq100 ?? 0);
  const points = [];

  // Fear & Greed
  if (fg <= 25) {
    points.push(`Fear & Greed ${Math.max(5, Math.round(fg - 8))}以下 → 恐怖深化、観測ポジション追加を検討`);
    points.push(`Fear & Greed ${Math.round(Math.ceil((fg + 12) / 5) * 5)}以上 → 恐怖圏緩和を確認、戦略を再評価`);
  } else if (fg <= 45) {
    points.push(`Fear & Greed ${Math.round(fg - 10)}以下 → 恐怖圏入り、警戒水準に移行`);
    points.push(`Fear & Greed ${Math.round(Math.ceil((fg + 8) / 5) * 5)}以上 → 中立圏回復、積み増しを検討`);
  } else if (fg <= 55) {
    points.push(`Fear & Greed ${Math.round(fg - 8)}以下 → 中立圏から恐怖寄りに転換、観察継続`);
    points.push(`Fear & Greed ${Math.round(Math.ceil((fg + 10) / 5) * 5)}以上 → 楽観圏入り、過熱に注意`);
  } else {
    points.push(`Fear & Greed ${Math.round(fg - 10)}以下 → 楽観圏から後退、利確・慎重化を検討`);
  }

  // VIX
  if (vix < 15) {
    points.push(`VIX ${Math.ceil(vix + 4)}超え → 低ボラから上昇転換、ポジション構築ペースを緩める`);
  } else if (vix < 20) {
    const warn = Math.round(Math.ceil(vix) + 3);
    points.push(`VIX ${warn}超え → 警戒水準入り、ポジション構築を一時保留`);
  } else if (vix < 25) {
    points.push(`VIX ${Math.round(vix - 3)}以下 → 緊張緩和シグナル、観測再開を判断`);
  } else {
    points.push(`VIX ${Math.round(vix - 5)}以下 → 高ボラ脱出、段階的な観測再開を検討`);
  }

  // NASDAQ100
  if (n100 >= 1) {
    points.push(`NASDAQ100 前日比 -0.5%以下 → 上昇一服、利確タイミングを確認`);
  } else if (n100 >= -1) {
    points.push(`NASDAQ100 前日比 +1%以上 → 反転シグナル、ポジション継続を判断`);
    points.push(`NASDAQ100 前日比 -1.5%以下 → 下落加速、追加逆張り機会を評価`);
  } else {
    const deeper    = Math.floor(n100 * 2) / 2 - 0.5;
    const deeperStr = deeper % 1 === 0 ? deeper.toFixed(0) : deeper.toFixed(1);
    points.push(`NASDAQ100 前日比 ${deeperStr}%以下 → 下落加速、さらなる逆張り機会を評価`);
    points.push(`NASDAQ100 前日比 +1%以上 → 反転シグナル、ポジション継続を判断`);
  }

  return [`## ⑧ 来週の注目条件`, '', ...points.map(p => `・${p}`)].join('\n');
}

/**
 * ⑨ 秘書室長総括
 * TODO: LLM実装時に ask() を呼ぶ
 * 内容: AI会社として今週何を学んだか。単なる市場解説ではなく経営週報として。
 */
function buildClosing(_data) {
  // TODO: 実装時は以下を追加
  //   const summary = buildWeekSummaryText(data);
  //   return await ask(WEEKLY_CLOSING_SYSTEM, summary, { num_predict: 600, temperature: 0.7 });

  return [
    `## ⑨ 秘書室長総括（相沢レイ）`,
    '',
    `（将来実装: AI会社として今週何を学んだかを経営週報として文章化）`,
  ].join('\n');
}

// ── メイン ──────────────────────────────────────────────────

/**
 * 週刊記事ドラフトを組み立てる
 * LLM呼び出しなし・note保存なし（設計フェーズ）
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {Promise<string>} note マークダウン
 */
async function buildWeeklyDraft(startDate, endDate) {
  const data = await gatherWeeklyData(startDate, endDate);
  const meta = buildWeeklyMeta(startDate, endDate);

  const header = [
    `# 週刊 AI Capital レポート ${meta.week_id}`,
    `${startDate}〜${endDate}`,
    '',
    '*AI社員4部署による市場観測の週間まとめです。*',
    '',
  ].join('\n');

  const sections = [
    buildConclusion(data),
    buildMarket(data),
    buildVotes(data),
    buildPortfolio(data),
    buildOrders(data),
    buildComments(data),
    buildTrends(data),
    buildWatchPoints(data),
    buildClosing(data),
  ];

  const footer = [
    '',
    '---',
    '*AI Capitalは投資助言サービスではありません。AI社員による意思決定の記録を公開するプロジェクトです。投資判断はご自身の責任でお願いします。*',
  ].join('\n');

  const note = header + sections.join('\n\n') + footer;
  return { note, meta };
}

module.exports = { weekId, buildWeeklyMeta, gatherWeeklyData, buildWeeklyDraft };
