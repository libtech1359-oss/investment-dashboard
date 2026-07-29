'use strict';

/**
 * weekly.js — 週刊記事エージェント（V1）
 *
 * 日刊記事の単純な集約ではなく、「AI Capitalが1週間をどう分析し、
 * どう判断し、何を学んだか」を伝える記事を組み立てる。
 *
 * 構成（V1.5・15セクション）:
 *   ① 今週の総括（LLM・30秒で伝わる文章）
 *   ② 今週のトピック（機械生成・3〜5項目）
 *   ③ 今週のマーケット振り返り（機械生成 + 推移チャート）
 *   ④ AI Capitalの行動履歴（機械生成）
 *   ⑤ 部署別レビュー（LLM: 部署ごとに1回・個性が伝わる一言つき）
 *   ⑥ 今週の判断ハイライト（LLM・対立から結論までのストーリー）
 *   ⑦ ポートフォリオ変化（機械生成・前週比較）
 *   ⑧ AIが学んだこと（LLM・今週の議論から得た判断基準/改善点）
 *   ⑨ 来週の注目条件（機械生成）
 *   ⑩ 秘書室長週報（LLM: 相沢レイ・振り返り＋組織方針としての展望）
 *   ⑪ 今週のAI社員MVP（LLM・選出理由＋今週の貢献）
 *   ⑫ 今週の一言（名言）（LLM・発言者/発言内容/一言解説の3行、担当は毎週変動）
 *   ⑬ 来週のAI Capital会議テーマ（LLM）
 *   ⑭ 次号予告（LLM・読者向けteaser）
 *   ⑮ 今週の記事品質（機械生成・quality_scores参照・日次スコア/前週比改善項目/4週間推移。Phase4）
 *
 * 章構成は WEEKLY_SECTIONS（本ファイル下部）が単一の正本。毎週この順序・
 * 章数のまま「固定テンプレート＋可変データ（gatherWeeklyDataが集めるその週のデータ）」
 * で生成するため、通常運用が続く限りプロンプトの手直しは不要。
 *
 * 重大イベントの自動反映（人手のログ記録に依存しない）:
 *   投資哲学変更・Rule Engine変更・評価ロジック変更・Validator追加・候補資産追加・
 *   部署追加・AI社員追加・重大バグ修正・大型イベントは、コード変更のコミット時に
 *   git の post-commit フック（scripts/auto-devlog.js）が diff を解析して自動分類し、
 *   development_logs への記録・バージョン更新（lib/systemVersion.js）・
 *   CHANGELOG.md の更新までを人手を介さず行う。誰かが saveDevelopmentLog() を
 *   書き忘れても記録は残る（分類できない変更は type:'OTHER' として記録され、
 *   Weekly記事へは反映されない＝通常運用として扱われる）。
 *   weekly.js はその結果（development_logs）を読むだけで、①②⑧⑩へ自動反映する。
 *
 * サムネイル: 日刊用と異なり、固定ファイル data/weekly_assets/週刊サムネ.png を使用する。
 *
 * 手動実行: node _run_weekly.js YYYY-MM-DD YYYY-MM-DD
 */

const sheets      = require('../lib/sheets');
const { ask }     = require('../lib/ollama');
const development = require('./development');

// ── 定数 ─────────────────────────────────────────────────────

const INITIAL_ASSETS = 10_000_000;

const DEPT_DISPLAY = {
  market:    { name: '神谷シン',   dept: 'マーケット分析部',     emoji: '📈' },
  risk:      { name: '黒崎ミサキ', dept: 'リスク管理部',         emoji: '🛡️' },
  portfolio: { name: '橘アオイ',   dept: 'ポートフォリオ管理部', emoji: '💼' },
  audit:     { name: '鬼塚ガイ',   dept: '審査部',               emoji: '🔍' },
};

// agent_votes/agent_recommendations の department 表記 → 内部キー
const DEPT_KEY_BY_LABEL = {
  'マーケット分析部':     'market',
  'リスク管理部':         'risk',
  'ポートフォリオ管理部': 'portfolio',
  '審査部':               'audit',
};

const SIGNAL_WEIGHT = { BUY: 2, ACCUMULATE: 1, WAIT: 0, DEFEND: -1, SELL: -2 };

// ── Week ID ───────────────────────────────────────────────────

/**
 * ISO 8601 週番号から week_id を生成する
 * 例: '2026-06-26' → '2026-W26'
 */
function weekId(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function buildWeeklyMeta(startDate, endDate) {
  return {
    week_id:      weekId(startDate),
    start_date:   startDate,
    end_date:     endDate,
    status:       'draft',
    generated_at: null,
    published_at: null,
  };
}

function dayBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── データ取得 ────────────────────────────────────────────────

/**
 * 指定期間のデータを全シートから収集する
 */
async function gatherWeeklyData(startDate, endDate) {
  const [
    marketRows,
    voteRows,
    recRows,
    decisionRows,
    orderRows,
    pfThisWeek,
    pfPrevWeek,
    positionRows,
    devLogRows,
  ] = await Promise.all([
    sheets.getRowsByDateRange('market_data',          startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('agent_votes',           startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('agent_recommendations', startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('final_decisions',       startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('orders',                startDate, endDate).catch(() => []),
    sheets.getLatestRowAsOf('portfolio_status', endDate).catch(() => null),
    sheets.getLatestRowAsOf('portfolio_status', dayBefore(startDate)).catch(() => null),
    sheets.getRows('positions').catch(() => []),
    sheets.getRowsByDateRange('development_logs',      startDate, endDate).catch(() => []),
  ]);

  const majorEvents = devLogRows
    .filter(r => development.isMajorEvent(r.type))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    period:        { start: startDate, end: endDate, days: marketRows.length },
    market:        marketRows.sort((a, b) => (a.date < b.date ? -1 : 1)),
    marketSummary: summarizeMarket(marketRows),
    decisions:     decisionRows,
    orders:        orderRows,
    votesByDept:   aggregateVotesByDept(voteRows),
    recsByDept:    aggregateRecsByDept(recRows),
    portfolio:     pfThisWeek,
    portfolioPrev: pfPrevWeek,
    positions:     positionRows,
    latestMarket:  marketRows[marketRows.length - 1] ?? null,
    majorEvents,
  };
}

// ── 重大イベント（development_logs由来。git post-commitフックによる自動記録） ─
//
// その週に development.MAJOR_EVENT_TYPES 該当のログが1件でもあれば、
// weekContextText() 経由で全LLMセクションのcontextへ差し込まれる。
// ①総括・⑧学んだこと・⑩秘書室長週報のシステムプロンプトは、この項目がcontextに
// 存在する場合のみ必ず言及するよう固定文で指示済み（週ごとの手直し不要）。
function majorEventsContextText(events) {
  if (!events || events.length === 0) return null;
  return events.map(e => {
    const flags = [];
    if (e.impact)                                    flags.push(`影響度:${e.impact}`);
    if (String(e.breaking_change).toLowerCase() === 'true') flags.push('破壊的変更');
    if (e.version)                                   flags.push(`更新後バージョン:${e.version}`);
    const flagText = flags.length ? `（${flags.join(' / ')}）` : '';
    return `${e.date} [${e.type}] ${e.title}：${e.summary}${flagText}`;
  }).join('\n');
}

// その週の最後の重大イベント時点のバージョン（＝週末時点のAI Capitalバージョン）
function latestVersionThisWeek(events) {
  if (!events || events.length === 0) return null;
  return events[events.length - 1].version || null;
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
    sp500:      stat(pick('sp500')),
    nasdaq100:  stat(pick('nasdaq100')),
  };
}

function aggregateVotesByDept(voteRows) {
  const result = {};
  for (const key of Object.keys(DEPT_DISPLAY)) {
    result[key] = Object.fromEntries(Object.keys(SIGNAL_WEIGHT).map(s => [s, 0]));
  }
  for (const row of voteRows) {
    const key    = DEPT_KEY_BY_LABEL[row.department];
    const signal = (row.signal || '').toUpperCase();
    if (key && result[key] && signal in result[key]) result[key][signal]++;
  }
  return result;
}

function aggregateRecsByDept(recRows) {
  const result = {};
  for (const key of Object.keys(DEPT_DISPLAY)) result[key] = [];
  for (const row of recRows) {
    const key = DEPT_KEY_BY_LABEL[row.department];
    if (!key) continue;
    result[key].push({
      date:   row.date,
      type:   row.recommendation_type || row.action || '',
      asset:  row.asset_name || 'なし',
      amount: parseInt(row.amount || 0),
      reason: row.reason_summary || '',
    });
  }
  return result;
}

// ── ①今週の総括（LLM・30秒で伝わる文章） ─────────────────────

const WEEKLY_SUMMARY_SYSTEM = `あなたはAI Capital運用チーム全体を俯瞰する立場から、週刊レポートの書き出しを書きます。
「今週どのような1週間だったのか」が読者に30秒で伝わるよう、3〜4文の自然な文章でまとめてください。
・今週の市場評価
・AI Capitalの行動概要
・今週の結論
の3要素を、箇条書きではなく1つの流れる文章として織り込むこと。
与えられたデータのみを根拠にし、新しい数値を創作しないこと。数値を羅列するだけの文にしないこと。
【重要】contextに「今週の重大アップデート」という項目がある場合、それは今週AI Capitalに
加えられた仕様変更・ルール変更等の重大な出来事である。その場合は必ず1文でその内容に触れ、
「更新後バージョン」が含まれていれば「AI Capitalはv2.4へ更新されました」のように
バージョン番号も明記すること。この項目が無い場合は、通常通り上記3要素のみで構成すること
（無理に言及を作らないこと）。`;

async function buildSummary(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_SUMMARY_SYSTEM, ctx, { num_predict: 300, temperature: 0.6 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ① 今週の総括`, '', body.trim()].join('\n');
}

// ── ②今週のトピック（機械生成） ───────────────────────────────

function buildTopics(data) {
  const { orders, decisions, marketSummary, market, majorEvents } = data;
  if (!marketSummary) return `## ② 今週のトピック\n\nデータなし`;

  const assetCounts = {};
  for (const o of orders) {
    const name = o.asset_name || '不明';
    assetCounts[name] = (assetCounts[name] || 0) + 1;
  }
  const topAsset  = Object.entries(assetCounts).sort((a, b) => b[1] - a[1])[0];
  const waitCount = decisions.filter(d => (d.final_signal || '').toUpperCase() === 'WAIT').length;
  const fgAvg     = marketSummary.fear_greed?.avg;

  // 今週最大の出来事: Fear&Greedが最も低かった日（恐怖が最も強まった局面）を機械抽出
  let bigEvent = '特筆すべき急変動なし';
  if (market.length > 0) {
    const worst = [...market]
      .filter(r => !isNaN(parseFloat(r.fear_greed)))
      .sort((a, b) => parseFloat(a.fear_greed) - parseFloat(b.fear_greed))[0];
    if (worst) {
      const d = decisions.find(x => x.date === worst.date);
      bigEvent = `${worst.date}にFear & Greedが${worst.fear_greed}まで低下${d ? `、AI Capitalは${d.final_signal}と判断` : ''}`;
    }
  }

  // システム更新: development_logs 由来の重大イベントを機械的にそのまま列挙する（毎週固定の形式）
  const systemUpdate = (majorEvents && majorEvents.length > 0)
    ? majorEvents.map(e => `${e.type}：${e.title}`).join(' / ')
    : 'なし（通常運用週）';
  const versionNote = latestVersionThisWeek(majorEvents);

  const items = [
    `投資回数：${orders.length}回${topAsset ? `（最多は${topAsset[0]}へ${topAsset[1]}回）` : ''}`,
    `WAIT判断 ${waitCount}回`,
    `Fear & Greed平均 ${fgAvg ?? '—'}`,
    `今週最大の出来事：${bigEvent}`,
    `システム更新：${systemUpdate}${versionNote ? `（${versionNote} へ更新）` : ''}`,
  ];

  return [`## ② 今週のトピック`, '', ...items.map(i => `・${i}`)].join('\n');
}

// ── ③今週のマーケット振り返り（機械生成 + チャート） ───────────

function buildMarketRecap(data) {
  const { marketSummary } = data;
  if (!marketSummary) return `## ③ 今週のマーケット振り返り\n\nデータなし`;

  const fmt = (stat, digits = 1) => stat
    ? `${stat.min.toFixed(digits)} 〜 ${stat.max.toFixed(digits)}（平均 ${stat.avg.toFixed(digits)}）`
    : '—';

  return [
    `## ③ 今週のマーケット振り返り`,
    '',
    `▼HISTORY▼`,
    '',
    `📊 Fear & Greed : ${fmt(marketSummary.fear_greed, 0)}`,
    `⚡ VIX          : ${fmt(marketSummary.vix)}`,
    `💵 USD/JPY      : ${fmt(marketSummary.usdjpy, 2)} 円`,
    `📈 S&P500       : 前日比 ${fmt(marketSummary.sp500)} %`,
    `📈 NASDAQ100    : 前日比 ${fmt(marketSummary.nasdaq100)} %`,
  ].join('\n');
}

// ── ④AI Capitalの行動履歴（機械生成） ───────────────────────

function buildActionHistory(data) {
  const { decisions, orders, period } = data;
  if (!decisions.length) return `## ④ AI Capitalの行動履歴\n\n判断記録なし`;

  const sorted = [...decisions].sort((a, b) => (a.date < b.date ? -1 : 1));
  const rows = sorted.map(d => {
    const sig  = d.final_signal || '—';
    const ast  = d.selected_asset || d.target_asset || 'なし';
    const amt  = parseInt(d.selected_amount || d.amount || 0);
    return `・${d.date} | ${sig} | ${ast} | ${amt > 0 ? `¥${amt.toLocaleString()}` : '—'}`;
  });

  const totalBuy  = orders.reduce((s, o) => s + parseInt(o.amount || 0), 0);
  const buyCount  = sorted.filter(d => ['BUY', 'ACCUMULATE'].includes((d.final_signal || '').toUpperCase())).length;
  const waitCount = sorted.filter(d => (d.final_signal || '').toUpperCase() === 'WAIT').length;

  return [
    `## ④ AI Capitalの行動履歴`,
    '',
    ...rows,
    '',
    `**今週の総投資額**：¥${totalBuy.toLocaleString()}`,
    `**観測ポジション回数**：${buyCount}回 / ${period.days}営業日`,
    `**WAIT回数**：${waitCount}回`,
  ].join('\n');
}

// ── ⑤部署別レビュー（LLM・個性が伝わる内容） ───────────────────

// 成績表（数値・ランク）ではなく、個性・判断傾向が伝わる一言を添える
const DEPT_FLAVOR_INSTRUCTION = '\n最後の行に「今週のこの部署らしさ：（一言、20字程度）」を必ず追加すること。' +
  '数値・スコア・ランク付けではなく、人物像や判断のクセが伝わる言い回しで書くこと。';

const WEEKLY_DEPT_SYSTEM = {
  market: `あなたは神谷シン、AI Capitalのマーケット分析部長です。
今週1週間の自分の提案履歴（日付・シグナル・銘柄・根拠）を振り返り、以下2点を簡潔にまとめてください。
・買い提案の回数とその主な根拠（どの指標を重視したか）
・今週の相場観に一貫性があったかどうか
2〜3行、箇条書き。「〜でした」調。新しい数値を創作しないこと、与えられたデータのみ使うこと。` + DEPT_FLAVOR_INSTRUCTION,

  risk: `あなたは黒崎ミサキ、AI Capitalのリスク管理部長です。
今週1週間の自分の判断履歴を振り返り、以下2点を簡潔にまとめてください。
・今週最も警戒したポイント（集中投資率・ATH乖離・現金比率など）
・その警戒は的中したか、杞憂だったか
2〜3行、箇条書き。数字で殴る口調を維持。与えられたデータのみ使うこと。` + DEPT_FLAVOR_INSTRUCTION,

  portfolio: `あなたは橘アオイ、AI Capitalのポートフォリオ管理部長です。
今週1週間の自分の提案履歴を振り返り、以下2点を簡潔にまとめてください。
・今週の平均提案金額とその考え方
・今週の配分方針（現金比率をどう扱ったか）
2〜3行、箇条書き。与えられたデータのみ使うこと。` + DEPT_FLAVOR_INSTRUCTION,

  audit: `あなたは鬼塚ガイ、AI Capitalの審査部長です。
今週1週間、他部署の判断を監査してきた立場から、以下2点を簡潔にまとめてください。
・今週最も指摘した論点（他部署のロジックのどこを問題視したか）
・総合して今週の議論の質をどう評価するか
2〜3行、短い判定文で。与えられたデータのみ使うこと。` + DEPT_FLAVOR_INSTRUCTION,
};

function deptContextText(key, data) {
  const recs = data.recsByDept[key] || [];
  if (recs.length === 0) return '今週の提案記録なし。';
  return recs.map(r =>
    `${r.date} | ${r.type} | ${r.asset} | ${r.amount > 0 ? `¥${r.amount.toLocaleString()}` : '—'} | ${r.reason}`
  ).join('\n');
}

async function buildDeptReviews(data) {
  const order = ['market', 'risk', 'portfolio', 'audit'];
  const lines = [`## ⑤ 部署別レビュー`, ''];

  for (const key of order) {
    const meta = DEPT_DISPLAY[key];
    const ctx  = deptContextText(key, data);
    let comment;
    try {
      comment = await ask(WEEKLY_DEPT_SYSTEM[key], ctx, { num_predict: 280, temperature: 0.65 });
    } catch (e) {
      comment = `（コメント生成失敗: ${e.message}）`;
    }
    // 「今週のこの部署らしさ：」行を抽出し、本文とは別行に整形する
    const flavorMatch = comment.match(/今週のこの部署らしさ[：:]\s*(.+)/);
    const flavor   = flavorMatch ? flavorMatch[1].trim() : null;
    const mainText = comment.replace(/今週のこの部署らしさ[：:].*/s, '').trim();

    lines.push(`${meta.emoji} ${meta.name}（${meta.dept}）`, '', mainText, '');
    if (flavor) lines.push(`＞ ${flavor}`, '');
  }
  return lines.join('\n').trimEnd();
}

// ── ⑥今週の判断ハイライト（LLM） ─────────────────────────────

const WEEKLY_HIGHLIGHT_SYSTEM = `今週1週間のAI Capitalの判断データを見て、最も印象的だった判断を1〜2件選び、紹介してください。
観点の例（あくまで例。実際の内容はデータに基づくこと）：
・最も良かった判断
・最も難しかった判断（部署間で意見が割れた場面など）
・WAITが有効だった場面
・複数指標の総合評価が功を奏した場面
単に結果を述べるのではなく、「どの部署がどう主張し、何が対立し、最終的にどう決着したか」という
議論の流れ（ストーリー）が伝わるように書くこと。日付を明記し、各判断3〜4行程度。
与えられたデータのみ使うこと。新しい数値を創作しないこと。`;

async function buildHighlights(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_HIGHLIGHT_SYSTEM, ctx, { num_predict: 600, temperature: 0.65 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ⑥ 今週の判断ハイライト`, '', body.trim()].join('\n');
}

// ── ⑦ポートフォリオ変化（機械生成・前週比較） ─────────────────

function buildPortfolioChange(data) {
  const { portfolio: cur, portfolioPrev: prev } = data;
  if (!cur) return `## ⑦ ポートフォリオ変化\n\nデータなし`;

  const curTotal = parseInt(cur.total_assets || 0);
  const curCash  = parseFloat(cur.cash_ratio || 0);
  const curPl    = parseInt(cur.unrealized_pl || 0);
  const curPend  = parseInt(cur.pending || 0);

  const prevTotal = prev ? parseInt(prev.total_assets || 0) : INITIAL_ASSETS;
  const prevCash  = prev ? parseFloat(prev.cash_ratio || 0) : 100.0;
  const prevPl    = prev ? parseInt(prev.unrealized_pl || 0) : 0;

  const diffTotal = curTotal - prevTotal;
  const diffCash  = curCash - prevCash;
  const diffPl    = curPl - prevPl;
  const sign      = v => (v >= 0 ? '+' : '') + v.toLocaleString();

  const positions   = JSON.parse(cur.positions_json || '[]');
  const holdRatio   = curTotal > 0 ? (100 - curCash).toFixed(1) : '0.0';

  const posLines = positions.length
    ? positions.map(p => `  ・${p.name}：¥${Number(p.market_value || 0).toLocaleString()}`).join('\n')
    : '  ・なし';

  return [
    `## ⑦ ポートフォリオ変化`,
    '',
    `総資産　：¥${curTotal.toLocaleString()}（前週比 ${sign(diffTotal)}）`,
    `現金比率：${curCash.toFixed(1)}%（前週比 ${sign(+diffCash.toFixed(1))}pt）`,
    `保有比率：${holdRatio}%`,
    `注文中　：¥${curPend.toLocaleString()}`,
    `含み損益：${curPl >= 0 ? '+' : ''}¥${curPl.toLocaleString()}（前週比 ${sign(diffPl)}）`,
    '',
    `保有銘柄:`,
    posLines,
  ].join('\n');
}

// ── ⑧AIが学んだこと（LLM・判断基準の学習視点） ─────────────────

const WEEKLY_LEARNING_SYSTEM = `あなたはAI Capital運用チーム全体を俯瞰する立場です。
今週1週間、各部署が議論の中で示した根拠・対立・合意形成を踏まえ、
「今週の議論からAI Capitalが得た新しい判断基準や改善点」を3〜4点、箇条書きでまとめてください。
単なる市場解説ではなく、今週のやり取りを通じてAIの判断ロジックがどう変化・洗練されたかという視点で書くこと
（視点の例：単一指標だけで判断しない／複数指標の組み合わせを重視するようになった／保有比率や集中度を判断材料に加えた、など。ただし例の丸写しは禁止）。
与えられたデータから読み取れる具体的な傾向のみ書くこと。各項目1行、簡潔に。
【重要】contextに「今週の重大アップデート」という項目がある場合、それは今週AI Capitalの
判断ロジック・ルール・体制に加えられた変更である。箇条書きの1項目として、その変更が
AI Capitalの判断にどう影響するかを必ず含めること。この項目が無い場合は、通常通り
判断精度の向上・部署間の議論・運用改善といった観点でまとめること。`;

function weekContextText(data) {
  const { marketSummary, decisions, orders, votesByDept, recsByDept, majorEvents } = data;
  const parts = [];
  const eventsText = majorEventsContextText(majorEvents);
  if (eventsText) parts.push(`今週の重大アップデート:\n${eventsText}`);
  if (marketSummary) {
    parts.push(`Fear&Greed: ${marketSummary.fear_greed?.min}-${marketSummary.fear_greed?.max}(avg ${marketSummary.fear_greed?.avg}) / VIX: ${marketSummary.vix?.min}-${marketSummary.vix?.max}(avg ${marketSummary.vix?.avg})`);
  }
  parts.push(`最終判断: ${decisions.map(d => `${d.date}=${d.final_signal}`).join(', ') || 'なし'}`);
  parts.push(`発注: ${orders.map(o => `${o.date} ${o.asset_name} ¥${o.amount}`).join(', ') || 'なし'}`);
  for (const [key, meta] of Object.entries(DEPT_DISPLAY)) {
    const reasons = (recsByDept[key] || []).map(r => r.reason).filter(Boolean);
    if (reasons.length) parts.push(`${meta.dept}の根拠: ${reasons.join(' / ')}`);
  }
  return parts.join('\n');
}

async function buildLearning(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_LEARNING_SYSTEM, ctx, { num_predict: 350, temperature: 0.6 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ⑧ AIが学んだこと`, '', body.trim()].join('\n');
}

// ── ⑨来週の注目条件（機械生成） ─────────────────────────────

function buildWatchPoints(data) {
  const mkt = data.latestMarket;
  if (!mkt) return `## ⑨ 来週の注目条件\n\nデータなし`;

  const fg   = parseFloat(mkt.fear_greed ?? 50);
  const vix  = parseFloat(mkt.vix ?? 15);
  const n100 = parseFloat(mkt.nasdaq100 ?? 0);
  const points = [];

  if (fg <= 25)      points.push(`Fear & Greed：${Math.max(5, Math.round(fg - 8))}以下で恐怖深化、${Math.round(fg + 12)}以上で緩和`);
  else if (fg <= 45)  points.push(`Fear & Greed：${Math.round(fg - 10)}以下で警戒、${Math.round(fg + 8)}以上で中立回復`);
  else if (fg <= 55)  points.push(`Fear & Greed：${Math.round(fg - 8)}以下で恐怖寄り転換に注意`);
  else                points.push(`Fear & Greed：${Math.round(fg - 10)}以下で楽観後退、利確・慎重化を検討`);

  if (vix < 15)       points.push(`VIX：${Math.ceil(vix + 4)}超えで警戒水準入り`);
  else if (vix < 25)  points.push(`VIX：${Math.round(vix - 3)}以下で緊張緩和`);
  else                points.push(`VIX：${Math.round(vix - 5)}以下で高ボラ脱出を確認`);

  points.push(`主要指数（S&P500・NASDAQ100）の反発・続落動向`);
  points.push(`ATH乖離率の拡大・縮小（候補銘柄のエントリータイミング）`);
  points.push(`ドル円の水準（保有資産の実質価値への影響）`);

  return [`## ⑨ 来週の注目条件`, '', ...points.map(p => `・${p}`)].join('\n');
}

// ── ⑩秘書室長週報（LLM） ─────────────────────────────────────

const WEEKLY_SECRETARY_SYSTEM = `あなたは相沢レイ、AI Capitalの秘書室長です。あなた自身は投資判断を行う立場ではありません。
今週1週間の会議・議論全体を振り返り、記事全体を締めくくる経営総括を書いてください。読み終えた読者が
「来週も見たい」と思えるような、締まりのある文章を目指すこと。
前半（振り返り）では以下を扱うこと：
・今週の議論で何が話し合われたか
・部署間で意見が分かれた点（データにその形跡があれば具体的に）
・最終判断に至った経緯、会議全体の雰囲気（緊張感があった／落ち着いていた、など）
後半（締め）では、来週へ向けた展望と、AI Capital全体としての方針を明確に打ち出すこと。
ただし「SOXを買うべき」のような具体的な投資方針・銘柄への言及は禁止。
「部署間の連携をより深めたい」「リスク許容度の判断基準を精緻化したい」のような、
AI Capitalという組織としての運営・議論姿勢に関する方針・展望に留めること。
地の文で、同じ表現・言い回しの繰り返しは避けること。5〜7行程度。与えられたデータのみを根拠にすること。
【重要】contextに「今週の重大アップデート」がある場合、前半の振り返りの中でその変更に触れ、
バージョン表記（例: v2.4）が含まれていれば「AI Capitalはv2.4へ更新されました」のように
明記すること。この項目が無い場合は、通常通り会議・議論の振り返りのみで構成すること。`;

async function buildSecretaryReport(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_SECRETARY_SYSTEM, ctx, { num_predict: 500, temperature: 0.7 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ⑩ 秘書室長週報（相沢レイ）`, '', body.trim()].join('\n');
}

// ── ⑪今週のAI社員MVP（LLM） ───────────────────────────────────

const WEEKLY_MVP_SYSTEM = `今週1週間のAI Capital各部署（神谷シン=マーケット分析部／黒崎ミサキ=リスク管理部／橘アオイ=ポートフォリオ管理部／鬼塚ガイ=審査部）の活動データを見て、
最も印象的だった1名を選出してください。
出力形式（厳守）：
MVP：（氏名）（部署）
理由：（1文、選出理由）
貢献：（2〜3文で、そのAI社員が今週どのように議論へ貢献したかを具体的に。単なる理由の繰り返しではなく、
　　　どんな場面でどう発言・提案し、議論の流れにどう影響したかを描写すること）
上記3行以外の文章・前置き・見出しは出力しないこと。`;

async function buildMvp(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_MVP_SYSTEM, ctx, { num_predict: 400, temperature: 0.65 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  // LLMが前置き・指示文をそのまま出力に混ぜることがあるため、"MVP" 以降だけを抽出する
  const idx = body.indexOf('MVP');
  let cleaned = (idx >= 0 ? body.slice(idx) : body).trim();
  cleaned = cleaned.replace(/上記3行以外の文章.*$/s, '').trim();
  return [`## ⑪ 今週のAI社員MVP`, '', cleaned].join('\n');
}

// ── ⑫今週の一言（名言）（LLM） ───────────────────────────────

const WEEKLY_QUOTE_SYSTEM = `今週1週間のAI Capital各部署（神谷シン=マーケット分析部／黒崎ミサキ=リスク管理部／橘アオイ=ポートフォリオ管理部／鬼塚ガイ=審査部／相沢レイ=秘書室長）の
やり取りを踏まえ、今週最も印象に残った発言を1つ選定・創作してください。担当者は毎週変わってよい。
【重要・厳守】
・与えられたデータの reason（判断根拠）や議事録の文章をそのまま引用・要約・言い換えしないこと。
・「〜%が高い」「〜%まで低下」のような数値をそのまま読み上げる発言は禁止。
・そのキャラクターが今週の出来事を振り返って言いそうな、性格・口調が滲み出るオリジナルの発言を作ること。
・毎週同じような言い回しにならないよう、今週ならではの出来事（対立した部署、判断の分かれ目など）の
　"空気感"を踏まえつつ、数値を直接引用しない比喩・言い回しにすること。
必ず1名分のみ出力すること。複数キャラクター分を書いた場合は不正解とする。
出力形式（厳守・この3行のみ）：
発言者：（氏名）（部署）
発言内容：「（20〜40字程度、そのキャラクターの口調で）」
一言解説：（なぜこの発言が今週を象徴するのか、事実に基づき1文で）
それ以外の文章は出力しないこと。`;

async function buildQuote(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_QUOTE_SYSTEM, ctx, { num_predict: 280, temperature: 0.85 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  // LLMが複数名分を出力することがあるため、最初の1組（発言者/発言内容/一言解説）だけを取り出す
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const quoteIdx = lines.findIndex(l => /^発言内容[：:]/.test(l));
  let result = body.trim();
  if (quoteIdx >= 0) {
    let speaker = null;
    for (let i = quoteIdx - 1; i >= 0; i--) {
      if (lines[i]) { speaker = lines[i].replace(/^発言者[：:]\s*/, ''); break; }
    }
    let explanation = null;
    if (lines[quoteIdx + 1] && /^一言解説[：:]/.test(lines[quoteIdx + 1])) {
      explanation = lines[quoteIdx + 1];
    }
    const parts = [];
    if (speaker) parts.push(`発言者：${speaker}`);
    parts.push(lines[quoteIdx]);
    if (explanation) parts.push(explanation);
    if (parts.length > 0) result = parts.join('\n');
  }
  return [`## ⑫ 今週の一言（名言）`, '', result].join('\n');
}

// ── ⑬来週のAI Capital会議テーマ（LLM） ───────────────────────

const WEEKLY_NEXT_THEME_SYSTEM = `AI Capitalの現在のポートフォリオ構成・今週の市場環境・今週の議論内容を踏まえ、
来週のAI Capital会議で議論すべきテーマを1件、疑問形で提案してください。
例（あくまで形式の例。内容はコピーしないこと）：
・SOX集中率30%は許容範囲か
・Fear & Greed30以下で追加投資すべきか
・ゴールド比率の見直しは必要か
実際の保有比率・市場水準・今週の対立点など、与えられたデータに基づいた具体的なテーマにすること。
翌週の議論に直接つながる、答えが1つに決まっていない問いにすること。
例のように15〜25字程度の短い問いかけにすること（長い説明文にしないこと）。
出力は「・」で始まる1行のみ。他の文章・前置き・見出しは一切書かないこと。`;

function nextThemeContextText(data) {
  const pf  = data.portfolio;
  const mkt = data.latestMarket;
  const positions = pf ? JSON.parse(pf.positions_json || '[]') : [];
  const posLine = positions.length
    ? positions.map(p => `${p.name}:¥${Number(p.market_value || 0).toLocaleString()}`).join(', ')
    : 'なし';

  return [
    `現金比率: ${pf?.cash_ratio ?? '—'}%`,
    `保有銘柄: ${posLine}`,
    `直近Fear&Greed: ${mkt?.fear_greed ?? '—'} / VIX: ${mkt?.vix ?? '—'}`,
    weekContextText(data),
  ].join('\n');
}

async function buildNextTheme(data) {
  const ctx = nextThemeContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_NEXT_THEME_SYSTEM, ctx, { num_predict: 150, temperature: 0.75 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  // 前置きが付いた場合の安全網: 「・」で始まる行があればそれを優先する
  const bulletLine = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('・')).pop();
  const line = (bulletLine || body.trim().split('\n').filter(Boolean).pop() || body.trim()).replace(/^・/, '');
  return [`## ⑬ 来週のAI Capital会議テーマ`, '', `・${line}`].join('\n');
}

// ── ⑭次号予告（LLM） ───────────────────────────────────────

const WEEKLY_PREVIEW_SYSTEM = `AI Capital週刊号の最後に置く「次号予告」を作成してください。
来週の市場注目点・保有銘柄の状況・今週の議論の流れを踏まえ、
読者が「来週も読みたい」と思えるteaser（予告）を2〜3項目、箇条書きで作成してください。
例（形式の参考。内容はそのままコピーしないこと）：
・Fear & Greedが30を割った場合のAI判断
・注目銘柄の最新評価
・来週の会議テーマの結論
具体的な数値・銘柄名を使い、続きが気になるフックのある文にすること。抽象的な一般論は禁止。
【重要・厳守】与えられたデータに存在しない数値・日付・曜日・出来事を創作しないこと。
「〜になった場合」「〜を割ったら」のように仮定・未来の問いかけとして書くのは良いが、
「今週すでに起きたこと」として事実と異なる内容（数値の向き・時系列など）を書かないこと。
出力は「・」で始まる箇条書き2〜3行のみ。他の文章・前置き・見出しは一切書かないこと。`;

async function buildPreview(data) {
  const ctx = nextThemeContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_PREVIEW_SYSTEM, ctx, { num_predict: 250, temperature: 0.75 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  const bullets = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('・'));
  const content = bullets.length > 0 ? bullets.join('\n') : body.trim();
  return [`## ⑭ 次号予告`, '', '【次号予告】', '', content].join('\n');
}

// ── ⑮今週の記事品質（機械生成・quality_scoresを参照・Phase4） ───

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

function fmtDayLabel(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return `${dateStr.slice(5).replace('-', '/')}(${WEEKDAY_JA[d.getUTCDay()]})`;
}

// 週の基準日から n週間前の同一曜日の日付を返す（weekBefore(d, 0) === d）
function weekBefore(dateStr, weeks) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7 * weeks);
  return d.toISOString().slice(0, 10);
}

// quality_scores の列名 → Weekly本文向けラベル（development_logsの品質改善検知とは独立）
const QUALITY_CATEGORY_LABELS = {
  layout_score:     'レイアウト',
  japanese_score:   '日本語品質',
  logic_score:      '投資ロジック',
  department_score: '部署人格',
  validator_score:  'Validator',
  editor_score:     '編集長評価',
};

function avgOf(rows, key) {
  const vals = rows.map(r => parseFloat(r[key])).filter(v => !isNaN(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

async function buildQualityReport(data) {
  const { start, end } = data.period;
  const thisWeekRows = await sheets.getRowsByDateRange('quality_scores', start, end).catch(() => []);

  if (thisWeekRows.length === 0) {
    return `## ⑮ 今週の記事品質\n\nデータなし`;
  }

  const sorted = [...thisWeekRows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const dailyLines = sorted.map(r => `${fmtDayLabel(r.date)}　${Math.round(parseFloat(r.total_score) || 0)}点`);
  const weekAvg = avgOf(sorted, 'total_score');

  const lines = [
    `## ⑮ 今週の記事品質`,
    '',
    ...dailyLines,
    '',
    `平均　${weekAvg != null ? Math.round(weekAvg * 10) / 10 : 'N/A'}点`,
  ];

  // ── 前週比でもっとも改善されたカテゴリ（実装④） ───────────────
  const prevWeekRows = await sheets.getRowsByDateRange(
    'quality_scores', weekBefore(start, 1), weekBefore(end, 1)
  ).catch(() => []);

  if (prevWeekRows.length > 0) {
    const improvements = Object.entries(QUALITY_CATEGORY_LABELS)
      .map(([key, label]) => {
        const curAvg  = avgOf(sorted, key);
        const prevAvg = avgOf(prevWeekRows, key);
        if (curAvg == null || prevAvg == null) return null;
        const delta = Math.round((curAvg - prevAvg) * 10) / 10;
        return delta > 0 ? { label, delta } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 3);

    if (improvements.length > 0) {
      lines.push('', '今週もっとも改善された項目', '');
      improvements.forEach(i => lines.push(`${i.label}　+${i.delta}点`));
    }
  }

  // ── 4週間の品質推移（実装⑤） ───────────────────────────────
  const trendWeeks = [];
  for (let i = 3; i >= 0; i--) {
    const wStart = weekBefore(start, i);
    const wEnd   = weekBefore(end, i);
    const rows   = await sheets.getRowsByDateRange('quality_scores', wStart, wEnd).catch(() => []);
    const scores = rows.map(r => parseFloat(r.total_score)).filter(v => !isNaN(v));
    if (scores.length === 0) continue;
    trendWeeks.push({
      week_id: weekId(wStart),
      avg: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10,
      min: Math.min(...scores),
      max: Math.max(...scores),
    });
  }

  if (trendWeeks.length > 0) {
    lines.push('', '品質推移（過去4週間）', '');
    trendWeeks.forEach(w => lines.push(`${w.week_id}　平均${w.avg}点（最低${w.min}／最高${w.max}）`));

    if (trendWeeks.length >= 2) {
      const first = trendWeeks[0].avg;
      const lastW = trendWeeks[trendWeeks.length - 1].avg;
      if (first > 0) {
        const rate = Math.round((lastW - first) / first * 1000) / 10;
        lines.push('', `改善率　${rate >= 0 ? '+' : ''}${rate}%`);
      }
    }
  }

  return lines.join('\n');
}

// ── note.com向けクリーンアップ ─────────────────────────────────

/**
 * note.comのエディタはMarkdown記法を解釈しないため、見出し記号・強調記号・
 * 水平線を除去してプレーンテキストとして読める形に整形する。
 * (publisher.js の後処理群とは独立した、週刊専用の簡易版)
 */
function cleanupForNote(markdown) {
  let note = markdown;
  // ▼HISTORY▼ マーカーは除去しない: noteDraft.saveDraft() が画像挿入時に見つけて置き換える
  note = note.replace(/^#{2,3}[ \t]*/gm, '');
  note = note.replace(/\*\*(.+?)\*\*/g, '$1');
  note = note.replace(/^\*[ \t]{1,4}/gm, '・');       // Markdown箇条書き「* 」→「・」
  note = note.replace(/^---[ \t]*$/gm, '');
  note = note.replace(/\n{3,}/g, '\n\n');
  return note.trim();
}

// ── 固定テンプレート定義（①〜⑭・単一の正本） ───────────────────
//
// Weekly記事の章構成・順序はこの配列だけが正本（single source of truth）。
// 章を追加/削除/並べ替えたい場合はここを編集する（buildWeeklyDraft側は不変）。
// 各 build は (data) → string | Promise<string> を返す関数で、
// data（その週のデータ）だけが週ごとに変化し、build自体（＝テンプレート・
// プロンプト）は固定のまま再利用される、という「固定テンプレート＋可変データ」
// 構造をこの配列がそのまま体現している。
const WEEKLY_SECTIONS = [
  { no: '①',  title: '今週の総括',             build: buildSummary },
  { no: '②',  title: '今週のトピック',           build: buildTopics },
  { no: '③',  title: '今週のマーケット振り返り',   build: buildMarketRecap },
  { no: '④',  title: 'AI Capitalの行動履歴',     build: buildActionHistory },
  { no: '⑤',  title: '部署別レビュー',           build: buildDeptReviews },
  { no: '⑥',  title: '今週の判断ハイライト',       build: buildHighlights },
  { no: '⑦',  title: 'ポートフォリオ変化',        build: buildPortfolioChange },
  { no: '⑧',  title: 'AIが学んだこと',           build: buildLearning },
  { no: '⑨',  title: '来週の注目条件',           build: buildWatchPoints },
  { no: '⑩',  title: '秘書室長週報',             build: buildSecretaryReport },
  { no: '⑪',  title: 'MVP',                    build: buildMvp },
  { no: '⑫',  title: '今週の一言',               build: buildQuote },
  { no: '⑬',  title: '来週のAI Capital会議テーマ', build: buildNextTheme },
  { no: '⑭',  title: '次号予告',                 build: buildPreview },
  { no: '⑮',  title: '今週の記事品質',           build: buildQualityReport },
];

// ── メイン ──────────────────────────────────────────────────

/**
 * 週刊記事ドラフトを組み立てる（LLM呼び出しあり・note保存なし）
 * WEEKLY_SECTIONS の順で①〜⑭を毎週固定生成する。
 * （LLM負荷を局所に集中させないよう、機械生成/LLM生成を問わず順次実行する）
 * @returns {Promise<{ note: string, meta: object, chartData: Array }>}
 */
async function buildWeeklyDraft(startDate, endDate) {
  const data = await gatherWeeklyData(startDate, endDate);
  const meta = buildWeeklyMeta(startDate, endDate);

  const header = [
    `# 📊 AI Capital 週刊号　${meta.week_id}（${startDate}〜${endDate}）`,
    '',
    '*AI社員4部署による、1週間の市場観測と判断のまとめです。*',
    '',
  ].join('\n');

  const sections = [];
  for (const section of WEEKLY_SECTIONS) {
    sections.push(await section.build(data));
  }

  const footer = [
    '',
    '---',
    '*AI Capitalは投資助言サービスではありません。AI社員による意思決定の記録を公開するプロジェクトです。投資判断はご自身の責任でお願いします。*',
  ].join('\n');

  const note = header + sections.join('\n\n') + footer;
  return { note, meta, marketRows: data.market };
}

/**
 * 週刊記事を組み立て、note.comに下書き保存する。
 * @returns {Promise<{ note: string, meta: object, noteUrl: string|null }>}
 */
// 日刊記事はAC番号ごとにサムネイルを動的生成するが、週刊号は固定のこのファイルを常に使う
const WEEKLY_THUMB_PATH = require('path').join(__dirname, '../data/weekly_assets/週刊サムネ.png');

async function publishWeekly(startDate, endDate) {
  const chartGen  = require('../lib/chartGenerator');
  const noteDraft = require('../lib/noteDraft');
  const fs        = require('fs');

  const { note, meta, marketRows } = await buildWeeklyDraft(startDate, endDate);

  let trendChartPath = null;
  try {
    trendChartPath = await chartGen.generateWeeklyTrendChart(marketRows, meta.week_id);
  } catch (e) {
    console.warn(`[weekly] 推移チャート生成失敗: ${e.message}`);
  }

  // 週刊は▼HISTORY▼（推移チャート）1枚のみが仕様（円グラフに相当する▼CHART▼は使わない）
  const graphsGenerated = trendChartPath ? 1 : 0;
  console.log(`[weekly] Graphs Generated : ${graphsGenerated} / 1`);

  let cleaned  = cleanupForNote(note);
  const thumbPath = fs.existsSync(WEEKLY_THUMB_PATH) ? WEEKLY_THUMB_PATH : null;
  if (!thumbPath) console.warn(`[weekly] 週刊サムネイルが見つかりません: ${WEEKLY_THUMB_PATH}`);

  // 見出し検出に依存しない保険挿入（日刊publisher.jsと同じ最終防衛ライン）
  if (!cleaned.includes('▼HISTORY▼')) {
    console.warn('[weekly] ▼HISTORY▼ が本文に存在しないため末尾に保険挿入します');
    cleaned += '\n\n▼HISTORY▼\n';
  }

  let noteUrl = null;
  let graphsEmbedded = 0;
  try {
    const result = await noteDraft.saveDraft({ body: cleaned, historyChartPath: trendChartPath, thumbPath });
    noteUrl = result.url;
    graphsEmbedded = result.historyEmbedded ? 1 : 0;
    console.log(`[weekly] Graphs Embedded : ${graphsEmbedded} / 1`);
    if (graphsEmbedded < 1) {
      console.error(`[weekly] 推移チャートが記事へ埋め込まれませんでした（要確認）: ${noteUrl}`);
    }
  } catch (e) {
    console.error(`[weekly] note.com 下書き保存失敗: ${e.message}`);
  }

  return {
    note: cleaned, meta, noteUrl,
    chartsIncomplete: graphsEmbedded < 1,
    graphsGenerated, graphsEmbedded,
  };
}

module.exports = {
  weekId,
  buildWeeklyMeta,
  gatherWeeklyData,
  buildWeeklyDraft,
  publishWeekly,
  cleanupForNote,
  WEEKLY_SECTIONS,
};
