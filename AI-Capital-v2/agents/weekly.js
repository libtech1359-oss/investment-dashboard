'use strict';

/**
 * weekly.js — 週刊記事エージェント（V2・確定値ベース監査可能レポート）
 *
 * 週刊記事は日刊記事をLLMが単純に要約するのではなく、「1週間分の実際の判断履歴・
 * 市場データ・ポートフォリオ履歴を元に再構成した監査可能な週次レポート」として生成する。
 *
 * V2（2026-08-14）での設計変更:
 *   投資回数・WAIT回数・総投資額・銘柄別/部署別集計・市場平均値・前週比・勝者反省点の
 *   評価根拠・論争候補・今週最大の出来事候補・成長記録の根拠有無は、すべて
 *   lib/weeklyFacts.js が一次データ（market_data / agent_recommendations +
 *   department_recommendations / final_decisions / orders / portfolio_status /
 *   capital_events）から機械集計した「確定値」であり、LLMはこれを文章化するだけで
 *   再計算・創作を行わない（数値はLLMへのcontext内で明示的にロックする）。
 *   評価根拠が不足するセクション（⑤勝者・反省点／⑥論争／⑧成長記録）は、根拠が
 *   ない週にはLLMを呼ばず固定文を出力する。
 *   公開ゲート（Validator PASS・グラフ2/2生成・2/2埋め込み・Quality Score 95以上・
 *   AI編集長APPROVED）を日刊 agents/publisher.js と同水準で通過した場合のみ
 *   「公開可の下書き」として保存し、いずれか欠落時は必ず「要確認」の下書きとして
 *   保存する（一切公開しない＝ゼロ件終了の禁止は日刊と同じ方針）。
 *
 * 章構成（①〜⑬・単一の正本はWEEKLY_SECTIONS）:
 *   ① 今週の総括（LLM）　② 今週のトピック（機械生成）
 *   ③ 今週のマーケット振り返り（機械生成 + 推移チャート）
 *   ④ AI Capitalの行動履歴（機械生成）
 *   ⑤ 今週の勝者・反省点（LLM・評価根拠が無い週は固定文）
 *   ⑥ 今週の論争（LLM・対立候補が無い週は固定文）
 *   ⑦ ポートフォリオ変化（機械生成・前週比較 + 円グラフ）
 *   ⑧ 今週確認された改善点（LLM・根拠が無い週は固定文）
 *   ⑨ 来週の焦点（LLM）　⑩ 秘書室長週報（LLM）　⑪ 今週の一言（LLM）
 *   ⑫ 来週のAI Capital会議テーマ（LLM）　⑬ 次号予告（LLM）
 *
 * 週刊記事は一般読者向けの投資組織レポートであり、AI開発日誌ではない。品質スコア・
 * Rule Engine・feat:/fix:・Phase番号・Validator等の内部管理用語や実装内容は本文に一切
 * 出さない（WEEKLY_STYLE_RULESが正本）。
 *
 * 重大イベントの自動反映（人手のログ記録に依存しない）:
 *   development_logs の重大イベントは git post-commit フック（scripts/auto-devlog.js）が
 *   自動記録する。weekly.js はその結果を読むだけで①②⑧⑩へ反映する。
 *
 * サムネイル: 固定ファイル data/weekly_assets/週刊サムネ.png を使用する。
 *
 * 手動実行: node _run_weekly.js YYYY-MM-DD YYYY-MM-DD
 */

const sheets         = require('../lib/sheets');
const { ask }        = require('../lib/ollama');
const development    = require('./development');
const readerFeedback = require('../lib/readerFeedback');
const capitalEvents  = require('../lib/capitalEvents');
const weeklyFacts    = require('../lib/weeklyFacts');
const { cleanupWeeklyForNote } = require('../lib/weeklyAutoFix');
const { validateWeeklyArticle, NO_WINNER_TEXT, NO_DEBATE_TEXT, NO_GROWTH_TEXT } = require('../lib/weeklyArticleValidator');
const { scoreWeeklyArticle, PUBLISH_SCORE_THRESHOLD_WEEKLY } = require('../lib/weeklyQualityScorer');

// ── 定数 ─────────────────────────────────────────────────────

const DEPT_DISPLAY = {
  market:    { name: '神谷シン',   dept: 'マーケット分析部',     emoji: '📈' },
  risk:      { name: '黒崎ミサキ', dept: 'リスク管理部',         emoji: '🛡️' },
  portfolio: { name: '橘アオイ',   dept: 'ポートフォリオ管理部', emoji: '💼' },
  audit:     { name: '鬼塚ガイ',   dept: '審査部',               emoji: '🔍' },
};

// ── 数値フォーマット統一（① 一次データ指定：確定値の表示丸めを1箇所に集約する。
//    「Fear & Greed平均63.3」と「平均63」のような食い違いを防止する） ────────
function fmtFG(v)     { return v == null ? '—' : Math.round(v).toString(); }
function fmtVix(v)    { return v == null ? '—' : v.toFixed(1); }
function fmtUsdJpy(v) { return v == null ? '—' : v.toFixed(2); }
function fmtPct(v)    { return v == null ? '—' : v.toFixed(1); }

// ── 記事表現ルール（全LLMセクション共通の正本） ──────────────────────
const WEEKLY_STYLE_RULES = `
【表現ルール・厳守】
・「逆張り」「逆張り投資」「逆張り的視点」は使用禁止。代わりに「市場心理を総合評価した結果」
　「長期投資として魅力が高まった局面」「投資判断ロジックによる総合評価」のような、
　総合的な判断として自然に読める表現を使うこと。
・以下の開発・システム実装用語は一切使用禁止：feat: / fix: / commit / Phase1 / Phase2 /
　Quality Score / LLM / Validator / Git / バージョン管理 / Rule Engine / 内部システム名称 /
　開発ログ / コード実装内容。システム面の変更に触れる場合は、必ず一般読者向けの自然な文章に
　変換すること（例：「Rule Engineを更新」→「投資判断ロジックを改善しました」）。
・記事内に品質スコア・点数（例：98点、99点）や「Quality Score」「品質推移」「品質評価」「記事品質」
　等の内部管理指標は一切記載しないこと。
・Markdownの見出し記号（#、##）・強調記号（*、**）・引用記号（>）・横線（---）は一切使用しないこと。
　箇条書きは「・」のみを使うこと。

【数値ロック・厳守】
contextに含まれる数値（投資回数・WAIT回数・総投資額・市場データの平均値・前週比等）は
既に機械集計で確定済みである。これらの数値は必ずそのまま使用し、四捨五入のやり直し・
独自の再計算・桁の変更を行わないこと。contextに存在しない数値を新しく創作しないこと。`.trim();

// development_logs の type → 週刊記事で使う一般読者向けの言い回し
const MAJOR_EVENT_READER_PHRASE = {
  '投資哲学変更':     '投資方針の見直し',
  'Rule Engine変更':  '投資判断ロジックの改善',
  '評価ロジック変更': '評価方法の改善',
  'Validator追加':    '記事チェック体制の強化',
  '候補資産追加':     '投資候補資産の追加',
  '部署追加':         '新部署の設立',
  'AI社員追加':       '新しいAI社員の着任',
  '重大バグ修正':     '運用上の不具合の修正',
  '大型イベント':     '組織体制の大きな変更',
};

function sanitizeDevLogText(text) {
  if (!text) return '';
  return text
    .replace(/^(feat|fix|chore|refactor|docs|test|style|perf|build|ci)(\([^)]*\))?:\s*/i, '')
    .replace(/\bPhase\s?\d+\b/gi, '')
    .trim();
}

// ── Week ID ───────────────────────────────────────────────────

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
 * 指定期間のデータを一次ソースから収集し、lib/weeklyFacts.js で確定値化する。
 * 日刊記事生成ロジック・売買ロジック・final_decisions/department_recommendations の
 * 既存データには一切書き込まない（読み取り専用）。
 */
async function gatherWeeklyData(startDate, endDate) {
  const [
    marketRows,
    agentRecRows,
    deptRecRows,
    decisionRows,
    orderRows,
    pfThisWeek,
    pfPrevWeek,
    devLogRows,
    allCapitalEvents,
  ] = await Promise.all([
    sheets.getRowsByDateRange('market_data',               startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('agent_recommendations',      startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('department_recommendations', startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('final_decisions',             startDate, endDate).catch(() => []),
    sheets.getRowsByDateRange('orders',                       startDate, endDate).catch(() => []),
    sheets.getLatestRowAsOf('portfolio_status', endDate).catch(() => null),
    sheets.getLatestRowAsOf('portfolio_status', dayBefore(startDate)).catch(() => null),
    sheets.getRowsByDateRange('development_logs',             startDate, endDate).catch(() => []),
    capitalEvents.getAllEvents().catch(() => []),
  ]);

  const majorEvents = devLogRows
    .filter(r => development.isMajorEvent(r.type))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // capital_eventsはcreated_at（タイムスタンプ）のみを持つため、getRowsByDateRangeの
  // date/timestamp前提のフィルタとは別に日付範囲で絞り込む（読み取り専用）。
  const capitalEventsInWeek = allCapitalEvents.filter(e => {
    const day = (e.created_at || '').slice(0, 10);
    return day >= startDate && day <= endDate;
  });

  // 読者コメントは note.com 側の自動取得手段が無いため、_add_reader_feedback.js で
  // 手動記録された分のみを対象週で読み込む（ゼロ件が通常運用）。
  const weekReaderFeedback = readerFeedback.getFeedbackForWeek(startDate, endDate);

  const marketSorted = [...marketRows].sort((a, b) => (a.date < b.date ? -1 : 1));

  const facts = weeklyFacts.buildWeeklyFacts({
    market:        marketSorted,
    agentRecs:     agentRecRows,
    deptRecs:      deptRecRows,
    decisions:     decisionRows,
    orders:        orderRows,
    portfolio:     pfThisWeek,
    portfolioPrev: pfPrevWeek,
    capitalEventsInWeek,
    majorEvents,
    startDate, endDate,
  });

  return {
    period:        { start: startDate, end: endDate, days: marketSorted.length },
    market:        marketSorted,
    decisions:     decisionRows,
    orders:        orderRows,
    portfolio:     pfThisWeek,
    portfolioPrev: pfPrevWeek,
    latestMarket:  marketSorted[marketSorted.length - 1] ?? null,
    majorEvents,
    readerFeedback: weekReaderFeedback,
    facts,
  };
}

// ── 重大イベントのcontext変換 ────────────────────────────────────

function majorEventsContextText(events) {
  if (!events || events.length === 0) return null;
  return events.map(e => {
    const phrase = MAJOR_EVENT_READER_PHRASE[e.type] || '運用面の改善';
    const flags = [];
    if (e.impact)                                    flags.push(`影響度:${e.impact}`);
    if (String(e.breaking_change).toLowerCase() === 'true') flags.push('大幅な変更');
    if (e.version)                                   flags.push(`更新後バージョン:${e.version}`);
    const flagText = flags.length ? `（${flags.join(' / ')}）` : '';
    const title   = sanitizeDevLogText(e.title);
    const summary = sanitizeDevLogText(e.summary);
    return `${e.date} [${phrase}] ${title}：${summary}${flagText}`;
  }).join('\n');
}

function latestVersionThisWeek(events) {
  if (!events || events.length === 0) return null;
  return events[events.length - 1].version || null;
}

// ── ①今週の総括（LLM） ─────────────────────────────────────

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
バージョン番号も明記すること。この項目が無い場合は、通常通り上記3要素のみで構成すること。

${WEEKLY_STYLE_RULES}`;

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
  const { facts, majorEvents } = data;
  if (facts.period.tradingDays === 0) return `## ② 今週のトピック\n\nデータなし`;

  const topAssetEntry = Object.entries(facts.assetOrderCounts).sort((a, b) => b[1] - a[1])[0];
  const fgAvg = facts.marketStats.fear_greed?.avg;

  const systemUpdate = (majorEvents && majorEvents.length > 0)
    ? [...new Set(majorEvents.map(e => MAJOR_EVENT_READER_PHRASE[e.type] || '運用面の改善'))].join(' / ')
    : 'なし（通常運用週）';
  const versionNote = latestVersionThisWeek(majorEvents);

  const bigEventText = facts.biggestEvent ? facts.biggestEvent.description : '特筆すべき急変動なし';

  const items = [
    `投資回数：${facts.investCount}回${topAssetEntry ? `（最多は${topAssetEntry[0]}へ${topAssetEntry[1]}回）` : ''}`,
    `WAIT回数：${facts.waitCount}回`,
    `Fear & Greed平均：${fmtFG(fgAvg)}`,
    `今週最大の出来事：${bigEventText}`,
    `システム更新：${systemUpdate}${versionNote ? `（${versionNote} へ更新）` : ''}`,
  ];

  return [`## ② 今週のトピック`, '', ...items.map(i => `・${i}`)].join('\n');
}

// ── ③今週のマーケット振り返り（機械生成 + チャート） ───────────

function buildMarketRecap(data) {
  const ms = data.facts.marketStats;
  if (!ms.fear_greed && !ms.vix) return `## ③ 今週のマーケット振り返り\n\nデータなし`;

  const rangeFG  = ms.fear_greed  ? `${ms.fear_greed.min.toFixed(0)} 〜 ${ms.fear_greed.max.toFixed(0)}`   : '—';
  const rangeVix = ms.vix         ? `${ms.vix.min.toFixed(1)} 〜 ${ms.vix.max.toFixed(1)}`                 : '—';
  const rangeFx  = ms.usdjpy      ? `${ms.usdjpy.min.toFixed(2)} 〜 ${ms.usdjpy.max.toFixed(2)}円`         : '—';
  const rangeSp  = ms.sp500       ? `${ms.sp500.min.toFixed(1)} 〜 ${ms.sp500.max.toFixed(1)}%`            : '—';
  const rangeNd  = ms.nasdaq100   ? `${ms.nasdaq100.min.toFixed(1)} 〜 ${ms.nasdaq100.max.toFixed(1)}%`    : '—';

  return [
    `## ③ 今週のマーケット振り返り`,
    '',
    `▼HISTORY▼`,
    '',
    `📊 Fear & Greed：${rangeFG}`,
    `Fear & Greed平均：${fmtFG(ms.fear_greed?.avg)}`,
    ms.fear_greed?.minDate ? `週内最低：${ms.fear_greed.minDate}時点（${ms.fear_greed.min}）` : '',
    `⚡ VIX：${rangeVix}`,
    `VIX平均：${fmtVix(ms.vix?.avg)}`,
    `💵 USD/JPY：${rangeFx}`,
    `USD/JPY平均：${fmtUsdJpy(ms.usdjpy?.avg)}`,
    `📈 S&P500（前日比）：${rangeSp}`,
    `S&P500平均：${fmtPct(ms.sp500?.avg)}`,
    `📈 NASDAQ100（前日比）：${rangeNd}`,
    `NASDAQ100平均：${fmtPct(ms.nasdaq100?.avg)}`,
  ].filter(Boolean).join('\n');
}

// ── ④AI Capitalの行動履歴（機械生成） ───────────────────────

function buildActionHistory(data) {
  const { decisions, facts, period } = data;
  if (!decisions.length) return `## ④ AI Capitalの行動履歴\n\n判断記録なし`;

  const sorted = [...decisions].sort((a, b) => (a.date < b.date ? -1 : 1));
  const rows = sorted.map(d => {
    const sig = d.final_signal || '—';
    const ast = d.target_asset || 'なし';
    const amt = parseInt(d.amount || 0, 10);
    return `・${d.date} | ${sig} | ${ast} | ${amt > 0 ? `¥${amt.toLocaleString()}` : '—'}`;
  });

  return [
    `## ④ AI Capitalの行動履歴`,
    '',
    ...rows,
    '',
    `総投資額：¥${facts.totalInvested.toLocaleString()}`,
    `投資回数：${facts.investCount}回（うちACCUMULATE ${facts.accumulateCount}回）/ ${period.days}営業日`,
    `WAIT回数：${facts.waitCount}回`,
  ].join('\n');
}

// ── ⑤今週の勝者・反省点（LLM・評価根拠が無い週は固定文） ────────
//
// 「勝者」「反省点」はLLMの印象で決めない。lib/weeklyFacts.jsが機械算出した
// 部署別の評価指標（最終判断への採用回数・提案と最終判断の方向一致率・数値根拠を
// 伴う提案の割合）にのみ基づいて選出する。部署間に有意な差が無い週はLLMを呼ばず
// 「今週は明確な勝者を設定できません」を出力する（要件③・要件⑮の「敗者」→
// 「反省点」表記変更に対応）。

const WEEKLY_WINNER_LOSER_SYSTEM = `あなたはAI Capital運用チーム全体を俯瞰する立場です。
今週1週間の各部署（神谷シン=マーケット分析部／黒崎ミサキ=リスク管理部／橘アオイ=ポートフォリオ管理部／鬼塚ガイ=審査部）について、
contextに与えられた「部署別の確定評価指標」にのみ基づいて、
「今週最も判断過程が的確だった部署（勝者）」と「今週最も判断過程に見直しの余地があった部署（反省点）」を
それぞれ1部署ずつ選出してください。
【厳禁】市場が結果的に上がった／下がったという結果だけを根拠に「当たった／外れた」と評価すること
（後知恵評価）は禁止する。
【厳守】選出理由には、contextに与えられた確定評価指標（採用回数・方向一致率・数値根拠を伴う提案の割合等）
または部署ごとの提案履歴（date | action | asset | amount | reason）に実際に書かれている内容だけを使うこと。
それ以外の新しい評価軸・数値を創作しないこと。
出力形式（厳守）：
🏆 今週の勝者
（氏名）（部署）

理由
（2〜3文、contextの確定評価指標・提案履歴を具体的に引用して）

🔻 今週の反省点
（氏名）（部署）

理由
（2〜3文、contextの確定評価指標・提案履歴を具体的に引用して。人格を否定する書き方はせず、次に活かせる視点として書くこと）
上記の形式以外の文章・前置き・見出しは出力しないこと。同じ部署を両方に選ばないこと。

${WEEKLY_STYLE_RULES}`;

function deptContextText(key, data) {
  const recs = data.facts.recsByDept[key] || [];
  if (recs.length === 0) return '今週の提案記録なし。';
  return recs.map(r =>
    `${r.date} | ${r.action} | ${r.asset_name} | ${r.amount > 0 ? `¥${r.amount.toLocaleString()}` : '—'} | ${r.reason || '（理由記録なし）'}`
  ).join('\n');
}

function winnerLoserContextText(data) {
  const { facts } = data;
  const lines = ['■ 部署別の確定評価指標（この数値を根拠に選出すること。新しい評価軸・数値の創作は禁止）'];
  for (const [key, meta] of Object.entries(DEPT_DISPLAY)) {
    const e = facts.deptEvidence[key];
    lines.push(
      `${meta.name}（${meta.dept}）: 登場${e.appearances}回 / 最終判断への採用${facts.deptAdoptionCounts[key]}回 / ` +
      `提案と最終判断の方向一致率${e.matchRate ?? '—'}% / 数値根拠を伴う提案${e.numericReasonCount}回`
    );
  }
  lines.push('', '■ 部署ごとの提案履歴（date | action | asset | amount | reason）');
  for (const [key, meta] of Object.entries(DEPT_DISPLAY)) {
    lines.push(`【${meta.name}（${meta.dept}）】`);
    lines.push(deptContextText(key, data));
  }
  return lines.join('\n');
}

async function buildWinnerLoser(data) {
  const { facts } = data;
  if (!facts.winnerLoserEligible) {
    return [`## ⑤ 今週の勝者・反省点`, '', `${NO_WINNER_TEXT}。（${facts.winnerLoserIneligibleReason || '評価根拠不足'}）`].join('\n');
  }
  const ctx = winnerLoserContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_WINNER_LOSER_SYSTEM, ctx, { num_predict: 500, temperature: 0.6 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ⑤ 今週の勝者・反省点`, '', body.trim()].join('\n');
}

// ── ⑥今週の論争（LLM・対立候補が無い週は固定文） ─────────────
//
// lib/weeklyFacts.js が機械抽出した「実際に部署間で提案が割れた日」1件だけを対象にする。
// LLMは各部署のreason（実データ）の範囲内でのみ言い換え・要約でき、記録にない発言・
// 議論の創作は禁止する。引用Markdown（>）は使用しない。

const WEEKLY_DEBATE_SYSTEM = `以下は今週実際に部署間で提案が割れた日の実データです。このデータの範囲内だけを使って、
部署間の対立を紹介する文章を書いてください。
【厳守】
・与えられた各部署のreason（提案理由）に書かれていない主張・発言を新しく創作しないこと。
・「〜と主張しました」「〜という理由を挙げました」のように、reasonの内容を要約・言い換えする
　形で書くこと。かぎ括弧「」で発言のように書く場合も、reasonに実際に含まれる語句の範囲に
　留めること。
・Markdownの引用記号（>）は使用しないこと。通常の地の文として書くこと。
・最後に、実際の最終判断（シグナル・銘柄・理由）を明記し、部署の主張がどう反映された
　（あるいはされなかった）かを説明すること。
・日付を明記し、5〜8行程度。

${WEEKLY_STYLE_RULES}`;

function debateContextText(dc) {
  const lines = [`対象日: ${dc.date}`, '', '■ 各部署の実際の提案（このreasonの範囲内でのみ言い換え・引用すること）'];
  for (const p of dc.positions) {
    lines.push(`${p.department}: ${p.action} ${p.asset_name}${p.amount > 0 ? ` ¥${p.amount.toLocaleString()}` : ''} — reason: ${p.reason || '（記録なし）'}`);
  }
  lines.push('', `■ 実際の最終判断: ${dc.finalSignal || '—'} ${dc.finalAsset || ''} ${dc.finalAmount ? `¥${dc.finalAmount.toLocaleString()}` : ''}`.trim());
  lines.push(`■ 最終判断の理由（実データ）: ${dc.finalReason || '（記録なし）'}`);
  return lines.join('\n');
}

async function buildDebate(data) {
  const dc = data.facts.debateCandidate;
  if (!dc) {
    return [`## ⑥ 今週の論争`, '', `${NO_DEBATE_TEXT}。`].join('\n');
  }
  const ctx = debateContextText(dc);
  let body;
  try {
    body = await ask(WEEKLY_DEBATE_SYSTEM, ctx, { num_predict: 600, temperature: 0.7 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ⑥ 今週の論争`, '', body.trim()].join('\n');
}

// ── ⑦ポートフォリオ変化（機械生成・前週比較 + 円グラフ） ─────────
//
// 前週比は current - previous の機械計算のみ（要件⑦）。前週データが無い場合は
// 「算出不可」とし、推測値は一切出さない。

function buildPortfolioChange(data) {
  const { portfolio: cur, facts } = data;
  if (!cur) return `## ⑦ ポートフォリオ変化\n\nデータなし`;

  const curTotal = parseInt(cur.total_assets || 0, 10);
  const curCash  = parseFloat(cur.cash_ratio || 0);
  const curPl    = parseInt(cur.unrealized_pl || 0, 10);
  const curPend  = parseInt(cur.pending || 0, 10);
  const curInv   = parseInt(cur.invested || 0, 10);

  const pc = facts.portfolioChange;
  const sign  = v => (v >= 0 ? '+' : '') + v.toLocaleString();
  const signF = v => (v >= 0 ? '+' : '') + v.toFixed(1);

  const totalDiffText = (pc && pc.computable) ? sign(pc.totalDiff)              : '算出不可';
  const cashDiffText  = (pc && pc.computable) ? `${signF(pc.cashRatioDiff)}pt`  : '算出不可';
  const plDiffText    = (pc && pc.computable) ? sign(pc.unrealizedPlDiff)       : '算出不可';
  const invDiffText   = (pc && pc.computable) ? sign(pc.investedDiff)           : '算出不可';

  const positions = JSON.parse(cur.positions_json || '[]');
  const holdRatio = curTotal > 0 ? (100 - curCash).toFixed(1) : '0.0';

  const posLines = positions.length
    ? positions.map(p => `  ・${p.name}：¥${Number(p.market_value || 0).toLocaleString()}`).join('\n')
    : '  ・なし';

  const injectNote = (pc && pc.computable && pc.capitalInjectedThisWeek > 0)
    ? `（うち今週の資金注入：¥${pc.capitalInjectedThisWeek.toLocaleString()}）`
    : '';

  return [
    `## ⑦ ポートフォリオ変化`,
    '',
    `▼CHART▼`,
    '',
    `総資産：¥${curTotal.toLocaleString()}`,
    `総資産前週比：${totalDiffText}${injectNote}`,
    `現金比率：${curCash.toFixed(1)}%`,
    `現金比率前週比：${cashDiffText}`,
    `保有比率：${holdRatio}%`,
    `注文中：¥${curPend.toLocaleString()}`,
    `投資中資金：¥${curInv.toLocaleString()}`,
    `投資中資金前週比：${invDiffText}`,
    `含み損益：${curPl >= 0 ? '+' : ''}¥${curPl.toLocaleString()}`,
    `含み損益前週比：${plDiffText}`,
    '',
    `保有銘柄:`,
    posLines,
  ].join('\n');
}

// ── ⑧今週確認された改善点（LLM・根拠が無い週は固定文） ─────────
//
// 「AIが学んだ」という擬人化ストーリーを勝手に作らない。development_logs由来の
// 重大アップデートが無く、読者コメントも無い週はLLMを呼ばず固定文を出力する。
// 重大アップデートが無く読者コメントのみがある週は、LLMに「学んだ・成長した」
// という自己言及的な断定を禁止し、あくまで読者由来の視点として書かせる。

const WEEKLY_GROWTH_SYSTEM = `あなたはAI Capital運用チーム全体を俯瞰する立場です。
今週1週間、各部署が議論の中で示した根拠・対立・合意形成を踏まえ、
「今週確認された改善点」を3〜4点、箇条書きでまとめてください。
これは開発の進捗報告ではない。何を直したか・何を実装したかではなく、その出来事を通じて
「投資判断としてどんな教訓を得たか」を一般読者にも伝わる自然な言葉で書くこと。
与えられたデータから読み取れる具体的な傾向のみ書くこと。各項目1行、簡潔に。
【重要】contextに「今週の重大アップデート」という項目がある場合のみ、「学んだ」「成長した」
「意識が高まった」という自己言及的な表現を使ってよい。専門用語や実装内容には一切触れず、
その変化から得た投資判断上の教訓を箇条書きの1項目として必ず含めること
（例：「Rule Engineを更新」ではなく「複数の指標を組み合わせて判断する体制を強化した」）。
【重要】contextに「今週の重大アップデート」が無く「今週寄せられた読者コメント」のみがある場合、
「学んだ」「成長した」という断定表現は使用禁止。「読者から〜という視点が寄せられ、
それを踏まえて〜を意識するようになった」のように、あくまで読者由来の指摘として触れること。

${WEEKLY_STYLE_RULES}`;

function readerFeedbackContextText(entries) {
  if (!entries || entries.length === 0) return null;
  return entries
    .map(e => `${e.date} [読者から寄せられた視点${e.theme ? `・${e.theme}` : ''}] ${e.comment}`)
    .join('\n');
}

function weekContextText(data) {
  const { facts, majorEvents, readerFeedback: feedback } = data;
  const parts = [];
  const eventsText = majorEventsContextText(majorEvents);
  if (eventsText) parts.push(`今週の重大アップデート:\n${eventsText}`);

  const ms = facts.marketStats;
  if (ms.fear_greed || ms.vix) {
    parts.push(
      `Fear&Greed平均: ${fmtFG(ms.fear_greed?.avg)}（範囲 ${ms.fear_greed?.min}-${ms.fear_greed?.max}） / ` +
      `VIX平均: ${fmtVix(ms.vix?.avg)}（範囲 ${ms.vix?.min}-${ms.vix?.max}）`
    );
  }
  parts.push(`最終判断: ${data.decisions.map(d => `${d.date}=${d.final_signal}`).join(', ') || 'なし'}`);
  parts.push(`発注: ${data.orders.map(o => `${o.date} ${o.asset_name} ¥${o.amount}`).join(', ') || 'なし'}`);
  parts.push(`投資回数: ${facts.investCount}回 / WAIT回数: ${facts.waitCount}回 / 総投資額: ¥${facts.totalInvested.toLocaleString()}`);
  for (const [key, meta] of Object.entries(DEPT_DISPLAY)) {
    const reasons = (facts.recsByDept[key] || []).map(r => r.reason).filter(Boolean);
    if (reasons.length) parts.push(`${meta.dept}の根拠: ${reasons.join(' / ')}`);
  }
  const feedbackText = readerFeedbackContextText(feedback);
  if (feedbackText) parts.push(`今週寄せられた読者コメント:\n${feedbackText}`);
  return parts.join('\n');
}

async function buildGrowthRecord(data) {
  const { facts, readerFeedback: feedback } = data;
  const hasContent = facts.growthEvidence.hasEvidence || (feedback && feedback.length > 0);
  if (!hasContent) {
    return [`## ⑧ 今週確認された改善点`, '', `${NO_GROWTH_TEXT}。`].join('\n');
  }
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_GROWTH_SYSTEM, ctx, { num_predict: 350, temperature: 0.6 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  return [`## ⑧ 今週確認された改善点`, '', body.trim()].join('\n');
}

// ── ⑨来週の焦点（LLM） ───────────────────────────────────

const WEEKLY_FOCUS_SYSTEM = `AI Capitalの現在のポートフォリオ構成・直近の市場水準を踏まえ、
来週AI Capitalが最も注目している条件を3〜4項目、箇条書きで紹介してください。
項目の例（あくまで例。実際の条件・数値は与えられたデータに基づくこと）：
・Fear & Greedが一定水準を割る／超えるかどうか
・NASDAQ100やS&P500が反発するかどうか
・VIXが警戒水準を突破するかどうか
・ドル円の水準
・保有銘柄（Core資産）の反転・資金流入
単に数値条件を並べるのではなく、各項目について「なぜそれが重要なのか」を
現在の保有状況・現金比率・今週の議論を踏まえて一言添えること。
各項目は「・条件：理由」の1行にまとめ、長い説明文にしないこと。
与えられたデータに存在しない数値・銘柄を創作しないこと。未来の市場結果を予測する
断定表現（「〜になります」等）は使わず、「〜かどうか」という条件の提示に留めること。
出力は「・」で始まる箇条書きのみ。他の文章・前置き・見出しは一切書かないこと。

${WEEKLY_STYLE_RULES}`;

function currentStateContextText(data) {
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

async function buildFocusPoints(data) {
  if (!data.latestMarket) return `## ⑨ 来週の焦点\n\nデータなし`;
  const ctx = currentStateContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_FOCUS_SYSTEM, ctx, { num_predict: 350, temperature: 0.65 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  const bullets = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('・'));
  const content = bullets.length > 0 ? bullets.join('\n') : body.trim();
  return [`## ⑨ 来週の焦点`, '', content].join('\n');
}

// ── ⑩秘書室長週報（LLM） ─────────────────────────────────────

const WEEKLY_SECRETARY_SYSTEM = `あなたは相沢レイ、AI Capitalの秘書室長です。あなた自身は投資判断を行う立場ではありません。
今週1週間の会議・議論全体を振り返り、記事全体を締めくくる経営総括を書いてください。
前半（振り返り）では以下を扱うこと：
・今週の議論で何が話し合われたか
・部署間で意見が分かれた点（データにその形跡があれば具体的に）
・最終判断に至った経緯、会議全体の雰囲気
後半（締め）では、来週へ向けた展望と、AI Capital全体としての方針を明確に打ち出すこと。
ただし具体的な投資方針・銘柄への言及は禁止。
「部署間の連携をより深めたい」「リスク許容度の判断基準を精緻化したい」のような、
AI Capitalという組織としての運営・議論姿勢に関する方針・展望に留めること。
地の文で、同じ表現・言い回しの繰り返しは避けること。5〜7行程度。与えられたデータのみを根拠にすること。
【重要】contextに「今週の重大アップデート」がある場合、前半の振り返りの中でその変更に触れ、
バージョン表記（例: v2.4）が含まれていれば明記すること。この項目が無い場合は、
通常通り会議・議論の振り返りのみで構成すること。

${WEEKLY_STYLE_RULES}`;

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

// ── ⑪今週の一言（名言）（LLM） ───────────────────────────────

const WEEKLY_QUOTE_SYSTEM = `今週1週間のAI Capital各部署（神谷シン=マーケット分析部／黒崎ミサキ=リスク管理部／橘アオイ=ポートフォリオ管理部／鬼塚ガイ=審査部／相沢レイ=秘書室長）の
やり取りを踏まえ、今週最も印象に残った発言を1つ選定・創作してください。担当者は毎週変わってよい。
【重要・厳守】
・与えられたデータの reason（判断根拠）や議事録の文章をそのまま引用・要約・言い換えしないこと。
・「〜%が高い」「〜%まで低下」のような数値をそのまま読み上げる発言は禁止。
・そのキャラクターが今週の出来事を振り返って言いそうな、性格・口調が滲み出るオリジナルの発言を作ること。
必ず1名分のみ出力すること。複数キャラクター分を書いた場合は不正解とする。
出力形式（厳守・この3行のみ）：
発言者：（氏名）（部署）
発言内容：「（20〜40字程度、そのキャラクターの口調で）」
一言解説：（なぜこの発言が今週を象徴するのか、事実に基づき1文で）
それ以外の文章は出力しないこと。

${WEEKLY_STYLE_RULES}`;

async function buildQuote(data) {
  const ctx = weekContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_QUOTE_SYSTEM, ctx, { num_predict: 280, temperature: 0.85 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
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
  return [`## ⑪ 今週の一言`, '', result].join('\n');
}

// ── ⑫来週のAI Capital会議テーマ（LLM） ───────────────────────

const WEEKLY_NEXT_THEME_SYSTEM = `AI Capitalの現在のポートフォリオ構成・今週の市場環境・今週の議論内容を踏まえ、
来週のAI Capital会議で議論すべきテーマを1件、疑問形で提案してください。
実際の保有比率・市場水準・今週の対立点など、与えられたデータに基づいた具体的なテーマにすること。
翌週の議論に直接つながる、答えが1つに決まっていない問いにすること。
15〜25字程度の短い問いかけにすること（長い説明文にしないこと）。
出力は「・」で始まる1行のみ。他の文章・前置き・見出しは一切書かないこと。

${WEEKLY_STYLE_RULES}`;

async function buildNextTheme(data) {
  const ctx = currentStateContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_NEXT_THEME_SYSTEM, ctx, { num_predict: 150, temperature: 0.75 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  const bulletLine = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('・')).pop();
  const line = (bulletLine || body.trim().split('\n').filter(Boolean).pop() || body.trim()).replace(/^・/, '');
  return [`## ⑫ 来週のAI Capital会議テーマ`, '', `・${line}`].join('\n');
}

// ── ⑬次号予告（LLM・現在確定している状態からのみ生成） ─────────

const WEEKLY_PREVIEW_SYSTEM = `AI Capital週刊号の最後に置く「次号予告」を作成してください。
与えられた「現在の確定状態」（保有銘柄・現金比率・直近のFear&Greed/VIX・来週の会議テーマ・
現在も継続中の観測課題）だけを材料に、来週追跡できる観点を2〜3項目、箇条書きで作成してください。
【重要・厳守】
・与えられたデータに存在しない数値・日付・曜日・出来事を創作しないこと。
・未来の市場結果を断定する表現（「〜になります」「〜します」等）は禁止。
　「〜かどうか」「〜の動向」のように、来週まだ確定していない観測対象として書くこと。
・「今週すでに起きたこと」として事実と異なる内容（数値の向き・時系列など）を書かないこと。
出力は「・」で始まる箇条書き2〜3行のみ。他の文章・前置き・見出しは一切書かないこと。

${WEEKLY_STYLE_RULES}`;

async function buildPreview(data) {
  const ctx = currentStateContextText(data);
  let body;
  try {
    body = await ask(WEEKLY_PREVIEW_SYSTEM, ctx, { num_predict: 250, temperature: 0.7 });
  } catch (e) {
    body = `（生成失敗: ${e.message}）`;
  }
  const bullets = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('・'));
  const content = bullets.length > 0 ? bullets.join('\n') : body.trim();
  return [`## ⑬ 次号予告`, '', '【次号予告】', '', content].join('\n');
}

// ── 固定テンプレート定義（①〜⑬・単一の正本） ───────────────────

const WEEKLY_SECTIONS = [
  { no: '①',  title: '今週の総括',           build: buildSummary },
  { no: '②',  title: '今週のトピック',         build: buildTopics },
  { no: '③',  title: '今週のマーケット振り返り', build: buildMarketRecap },
  { no: '④',  title: 'AI Capitalの行動履歴',   build: buildActionHistory },
  { no: '⑤',  title: '今週の勝者・反省点',      build: buildWinnerLoser },
  { no: '⑥',  title: '今週の論争',             build: buildDebate },
  { no: '⑦',  title: 'ポートフォリオ変化',      build: buildPortfolioChange },
  { no: '⑧',  title: '今週確認された改善点',    build: buildGrowthRecord },
  { no: '⑨',  title: '来週の焦点',             build: buildFocusPoints },
  { no: '⑩',  title: '秘書室長週報',           build: buildSecretaryReport },
  { no: '⑪',  title: '今週の一言',             build: buildQuote },
  { no: '⑫',  title: '来週のAI Capital会議テーマ', build: buildNextTheme },
  { no: '⑬',  title: '次号予告',               build: buildPreview },
];

// ── メイン ──────────────────────────────────────────────────

/**
 * 週刊記事ドラフトを組み立てる（LLM呼び出しあり・note保存なし）
 * @returns {Promise<{ note: string, meta: object, data: object }>}
 */
async function buildWeeklyDraft(startDate, endDate) {
  const data = await gatherWeeklyData(startDate, endDate);
  const meta = buildWeeklyMeta(startDate, endDate);

  const header = [
    `# 📊 AI Capital 週刊号　${meta.week_id}（${startDate}〜${endDate}）`,
    '',
    'AI社員4部署による、1週間の市場観測と判断の監査可能なまとめです。',
    '',
  ].join('\n');

  const sections = [];
  for (const section of WEEKLY_SECTIONS) {
    sections.push(await section.build(data));
  }

  const footer = [
    '',
    '---',
    'AI Capitalは投資助言サービスではありません。AI社員による意思決定の記録を公開するプロジェクトです。投資判断はご自身の責任でお願いします。',
  ].join('\n');

  const note = header + sections.join('\n\n') + footer;
  return { note, meta, data };
}

const WEEKLY_THUMB_PATH = require('path').join(__dirname, '../data/weekly_assets/週刊サムネ.png');

/**
 * 週刊記事を組み立て、公開ゲート（Validator PASS・グラフ2/2生成・2/2埋め込み・
 * Quality Score 95以上・AI編集長APPROVED）を日刊 agents/publisher.js と同水準で
 * 通過した場合のみ「公開可の下書き」として保存する。いずれか欠落時は必ず
 * 「要確認」の下書きとして保存し、公開しない（ゼロ件終了の禁止）。
 * @returns {Promise<object>}
 */
async function publishWeekly(startDate, endDate) {
  const chartGen  = require('../lib/chartGenerator');
  const noteDraft = require('../lib/noteDraft');
  const { runEditorReview } = require('../lib/editorReview');
  const fs        = require('fs');

  const { note: draftNote, meta, data } = await buildWeeklyDraft(startDate, endDate);
  const facts = data.facts;

  // ── グラフ2枚生成（日刊 lib/chartGenerator.js の既存関数をそのまま呼ぶのみ・無改修） ──
  let trendChartPath = null;
  let portfolioChartPath = null;
  try {
    trendChartPath = await chartGen.generateWeeklyTrendChart(data.market, meta.week_id);
  } catch (e) {
    console.warn(`[weekly] 推移チャート生成失敗: ${e.message}`);
  }
  if (data.portfolio) {
    try {
      portfolioChartPath = await chartGen.generatePortfolioChart(data.portfolio, endDate);
    } catch (e) {
      console.warn(`[weekly] ポートフォリオ円グラフ生成失敗: ${e.message}`);
    }
  }
  const graphsGenerated = [trendChartPath, portfolioChartPath].filter(Boolean).length;
  console.log(`[weekly] Graphs Generated : ${graphsGenerated} / 2`);

  // ── 機械クリーンアップ（Markdown/引用記号除去。週刊専用） ────────────
  let cleaned = cleanupWeeklyForNote(draftNote).note;
  if (!cleaned.includes('▼HISTORY▼')) {
    console.warn('[weekly] ▼HISTORY▼ が本文に存在しないため末尾に保険挿入します');
    cleaned += '\n\n▼HISTORY▼\n';
  }
  if (!cleaned.includes('▼CHART▼')) {
    console.warn('[weekly] ▼CHART▼ が本文に存在しないため末尾に保険挿入します');
    cleaned += '\n\n▼CHART▼\n';
  }

  const thumbPath = fs.existsSync(WEEKLY_THUMB_PATH) ? WEEKLY_THUMB_PATH : null;
  if (!thumbPath) console.warn(`[weekly] 週刊サムネイルが見つかりません: ${WEEKLY_THUMB_PATH}`);

  async function saveFallbackDraft(reason) {
    try {
      const result = await noteDraft.saveDraft({
        title:            `【要確認】週刊号 下書き ${meta.week_id}（${reason}）`,
        body:             cleaned,
        historyChartPath: trendChartPath,
        chartPath:        portfolioChartPath,
        thumbPath,
      });
      console.log(`[weekly] 要確認Draftをnote下書きに保存しました（${reason}）: ${result.url}`);
      return result.url;
    } catch (err) {
      console.error(`[weekly] 要確認Draftの保存に失敗しました（${reason}）: ${err.message}`);
      return null;
    }
  }

  // ── Rule W12（グラフ2枚生成）ハードゲート ────────────────────────
  if (graphsGenerated < 2) {
    console.error(`[weekly] グラフ生成が${graphsGenerated}/2枚のため公開可の下書きにはできません`);
    const validation = validateWeeklyArticle(cleaned, facts, { graphsGenerated });
    const fallbackDraftUrl = await saveFallbackDraft('グラフ生成不足');
    return {
      note: cleaned, meta, noteUrl: null, fallbackDraftUrl, approved: false,
      validation, graphsGenerated, graphsEmbedded: 0, chartsIncomplete: true,
    };
  }

  // ── Validator（W01〜W11 本文整合性。グラフ埋め込みはこの時点でまだ未実施） ──
  const preValidation = validateWeeklyArticle(cleaned, facts, { graphsGenerated });
  if (!preValidation.ok) {
    console.warn(`[weekly] Validator NG（警告${preValidation.warnings.length}件）\n${preValidation.warnings.join('\n\n')}`);
    const fallbackDraftUrl = await saveFallbackDraft('Validator NG');
    return {
      note: cleaned, meta, noteUrl: null, fallbackDraftUrl, approved: false,
      validation: preValidation, graphsGenerated, graphsEmbedded: 0, chartsIncomplete: true,
    };
  }

  const score = scoreWeeklyArticle(preValidation);
  console.log(`[weekly] Quality Score: ${score.total}点`);
  if (score.total < PUBLISH_SCORE_THRESHOLD_WEEKLY) {
    console.warn(`[weekly] Quality Score ${score.total}点が公開基準(${PUBLISH_SCORE_THRESHOLD_WEEKLY}点)未満のため公開を見送ります`);
    const fallbackDraftUrl = await saveFallbackDraft('Quality Scoreが公開基準未満');
    return {
      note: cleaned, meta, noteUrl: null, fallbackDraftUrl, approved: false,
      validation: preValidation, score, graphsGenerated, graphsEmbedded: 0, chartsIncomplete: true,
    };
  }

  // ── AI編集長レビュー（lib/editorReview.js・日刊と共通の無改修実装をそのまま利用） ──
  console.log('[weekly] AI編集長レビュー実施中');
  const editorReview = await runEditorReview(cleaned, ask);
  console.log(`[weekly] AI編集長レビュー完了: 判定=${editorReview.verdict} 編集長スコア=${editorReview.editorScore ?? 'N/A'}`);
  if (editorReview.verdict !== 'APPROVED') {
    console.warn(`[weekly] AI編集長が公開を見送りました: ${editorReview.comment || editorReview.reasons.join(' / ')}`);
    const fallbackDraftUrl = await saveFallbackDraft('AI編集長が公開を見送り');
    return {
      note: cleaned, meta, noteUrl: null, fallbackDraftUrl, approved: false,
      validation: preValidation, score, editorReview, graphsGenerated, graphsEmbedded: 0, chartsIncomplete: true,
    };
  }

  // ── 下書き保存（グラフ埋め込み実施） ────────────────────────────
  let noteUrl = null;
  let graphsEmbedded = 0;
  try {
    const result = await noteDraft.saveDraft({
      body: cleaned, historyChartPath: trendChartPath, chartPath: portfolioChartPath, thumbPath,
    });
    noteUrl = result.url;
    graphsEmbedded = [result.historyEmbedded, result.chartEmbedded].filter(Boolean).length;
    console.log(`[weekly] Graphs Embedded : ${graphsEmbedded} / 2`);
  } catch (e) {
    console.error(`[weekly] note.com 下書き保存失敗: ${e.message}`);
  }

  // Validator再実行（グラフ埋め込み後・Rule W13/W14込みの最終判定）
  const finalValidation = validateWeeklyArticle(cleaned, facts, { graphsGenerated, graphsEmbedded });

  // ── Rule W14（graphsEmbedded < 2 は公開禁止）ハードゲート ─────────
  if (graphsEmbedded < 2) {
    console.error(`[weekly] グラフ埋め込みが${graphsEmbedded}/2枚のため公開停止・要確認です: ${noteUrl}`);
    return {
      note: cleaned, meta, noteUrl, approved: false,
      validation: finalValidation, score, editorReview,
      chartsIncomplete: true, graphsGenerated, graphsEmbedded,
    };
  }

  return {
    note: cleaned, meta, noteUrl, approved: true,
    validation: finalValidation, score, editorReview,
    chartsIncomplete: false, graphsGenerated, graphsEmbedded,
  };
}

module.exports = {
  weekId,
  buildWeeklyMeta,
  gatherWeeklyData,
  buildWeeklyDraft,
  publishWeekly,
  WEEKLY_SECTIONS,
};
