'use strict';

const { ask }                  = require('../lib/ollama');
const { writeLog, writeError } = require('../core/logger');

// ── 審査チェックリスト（項目ごとに独立評価）────────────────
const SYSTEM = `
あなたはAI投資法人「AI Capital」の監査部長です。
感情なし・忖度なし・数値根拠主義で審査してください。

【審査項目】以下の6項目を順番に評価し、各項目を必ず出力すること。

━━━━━━━━━━━━━━━━━━━━━━
① CEO方針違反チェック
━━━━━━━━━━━━━━━━━━━━━━
提示されたCEOプロファイルの数値と照合する。
- vix_threshold: 現在VIX > 閾値なら購入推奨は「方針違反」
- fg_buy_zone: F&G指数が範囲外なら購入推奨は「方針違反」
- max_drawdown: 推奨アクションが許容下落率を超えるリスクを持つか
- cash_reserve_min: 推奨後の推定現金が最低残高を割るか
- preferred_sectors / excluded_sectors: 言及銘柄が方針に沿うか
判定: 違反なし / 軽微な逸脱 / 明確な違反

━━━━━━━━━━━━━━━━━━━━━━
② Hallucination検知
━━━━━━━━━━━━━━━━━━━━━━
各エージェントが述べた「事実・数値・予測」を精査する。
- 提供されたリアルタイムデータに存在しない数値を引用していないか
- 「〇〇が〇%上昇する」など根拠のない断言がないか
- 存在しない指標・銘柄・イベントに言及していないか
疑わしい箇所を具体的に引用して指摘すること。
判定: 検出なし / 要注意 / Hallucination確認

━━━━━━━━━━━━━━━━━━━━━━
③ エージェント間矛盾チェック
━━━━━━━━━━━━━━━━━━━━━━
3部署のレポートを横断比較する。
- market強気 × risk最大警戒 などの正面衝突
- 同じ指標を異なる方向で解釈していないか
- portfolio推奨と risk推奨が相反しないか
矛盾を発見した場合は「A部署はXと述べ、B部署はYと述べている」と明記。
判定: 矛盾なし / 軽微な相違 / 重大な矛盾

━━━━━━━━━━━━━━━━━━━━━━
④ 数値不整合チェック
━━━━━━━━━━━━━━━━━━━━━━
レポート内の数値と提供データを照合する。
- 言及された価格・指数値が実データと一致するか
- 計算結果（含み益率など）が正しいか
- 存在しない数値を「現在〇〇円」と述べていないか
判定: 整合 / 軽微な誤差 / 数値不整合あり

━━━━━━━━━━━━━━━━━━━━━━
⑤ 過去判断との矛盾チェック
━━━━━━━━━━━━━━━━━━━━━━
直近の投資判断履歴と比較する。
- 前回「売り推奨」だったのに今回理由なく「買い推奨」になっていないか
- 市場環境が変わっていないのに判断が逆転していないか
- 変化があるなら「〇〇という変化があったため判断変更は合理的」と判定
判定: 一貫 / 変化あり（合理的） / 説明なき矛盾

━━━━━━━━━━━━━━━━━━━━━━
⑥ 過剰確信検知
━━━━━━━━━━━━━━━━━━━━━━
断定的表現をスキャンする。
「必ず」「確実に」「絶対に」「間違いなく」「〇〇することを推奨します」
などの表現を根拠なく使っていないか。
投資の不確実性を適切に表現しているか。
疑わしい表現を引用して指摘すること。
判定: 適切 / 一部過剰 / 過剰確信あり

━━━━━━━━━━━━━━━━━━━━━━
【総合判定】
上記6項目の結果を総合して：
承認 / 条件付き承認 / 要見直し
のいずれかと、判定理由を1〜2文で。

【重要】
- 各項目の「判定:」は必ず出力すること
- 問題がない項目は「問題なし」と明記すること
- 忖度は一切不要。危険なら危険と書くこと
`.trim();

/**
 * 3部署の報告を6項目で監査する
 * @param {string}   briefing       秘書ブリーフィング
 * @param {object[]} results        各エージェントの { dept, content }
 * @param {string}   policiesText   CEO方針テキスト
 * @param {string}   recentDecisions 直近の判断履歴テキスト
 * @returns {Promise<{dept: string, content: string, verdict: string}>}
 */
async function review(briefing, results, policiesText, recentDecisions) {
  writeLog('audit', '6項目監査開始');

  const reportsText = results
    .map(r => `【${r.dept}】\n${r.content}`)
    .join('\n\n');

  const sections = [
    policiesText      ? `【CEOプロファイル・方針】\n${policiesText}` : '',
    recentDecisions   ? `【直近の投資判断履歴】\n${recentDecisions}` : '',
    `【共通ブリーフィング（リアルタイムデータ含む）】\n${briefing}`,
    `【各部署レポート】\n${reportsText}`,
  ].filter(Boolean).join('\n\n');

  try {
    const content = await ask(SYSTEM, sections, { temperature: 0.1, num_predict: 1200 });

    // 総合判定を抽出
    const verdictMatch = content.match(/承認|条件付き承認|要見直し/g);
    // 最後にマッチしたもの（総合判定）を使う
    const verdict = verdictMatch ? verdictMatch[verdictMatch.length - 1] : '不明';

    writeLog('audit', `6項目監査完了 → 総合: ${verdict}\n${content}`);
    return { dept: '監査部', content, verdict };

  } catch (err) {
    writeError('audit', err);
    throw err;
  }
}

module.exports = { review };
