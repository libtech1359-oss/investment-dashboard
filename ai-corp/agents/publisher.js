'use strict';

const { ask }                  = require('../lib/ollama');
const { writeLog, writeError } = require('../core/logger');

// ── note.com 用システムプロンプト ────────────────────────────

const NOTE_SYSTEM = `
あなたはAI投資法人「AI Capital」の広報・編集部長です。
内部の分析レポートを、一般読者向けのnote記事に変換してください。

【絶対禁止表現】
- 「〜を買うべき」「〜を推奨します」「〜が上昇するでしょう」
- 「〜は必ず」「〜することを勧めます」「〜すれば儲かります」
- 銘柄名を主語にした断定的な価格予測

【代わりに使う表現】
- 「AIエージェントは〜と分析した」
- 「〜というリスクが指摘された」
- 「〜という見方が示された」
- 「AIの反対意見部は〜と懸念している」

【記事の性質】
- 「AIが何を考えたか」の記録・観察レポート
- 読者が自分で判断するための情報整理
- 断定ではなく問いかけのトーン

【出力形式】
# [具体的なタイトル（今日の市場の特徴を反映）]

## 今日の市場
（客観的な市場状況を2〜3文。数値は活用してよい）

## AIが注目したポイント
（箇条書き3点。主語は「AI」または「分析」）

## 指摘されたリスク
（devil部署・risk部署の懸念を中立的に。読者への警告ではなく記録として）

## 本日のAI総合所見
（最終判断の中立的な要約。「AIは〜という所見を示した」形式で）

---
*このレポートはAI Capital（AI投資法人シミュレーション）のAIエージェントが自動生成しました。投資判断はご自身の責任でお願いします。*
`.trim();

// ── X（旧Twitter）用システムプロンプト ──────────────────────

const X_SYSTEM = `
あなたはAI投資法人「AI Capital」のSNS担当です。
以下のnote記事から、X（旧Twitter）投稿文を1つ作成してください。

【制約】
- 140文字以内（日本語・改行含む）
- 投資推奨・断定表現は絶対禁止
- 「AIが分析した」という客観的スタンスを維持
- 絵文字は1〜2個のみ
- 末尾にハッシュタグ: #AI投資記録 #AI法人シミュレーション
- note記事を読んでもらうための導線を含める

【出力】
投稿文のみ。説明不要。
`.trim();

// ── メイン処理 ───────────────────────────────────────────────

/**
 * 完了済みタスクから note / X 用公開コンテンツを生成する
 * @param {object} task  taskStore.get() で取得したタスクドキュメント
 * @returns {Promise<{note: string, x: string}>}
 */
async function publish(task) {
  writeLog('publisher', `公開コンテンツ生成開始 [${task.id}]`);

  const sections = [];
  if (task.market?.content)    sections.push(`【市場分析部の報告】\n${task.market.content}`);
  if (task.risk?.content)      sections.push(`【リスク管理部の報告】\n${task.risk.content}`);
  if (task.devil?.content)     sections.push(`【反対意見部の報告】\n${task.devil.content}`);
  if (task.audit?.content) {
    const verdict = task.audit.verdict ? `総合判定: ${task.audit.verdict}\n` : '';
    sections.push(`【監査部の報告】\n${verdict}${task.audit.content}`);
  }

  if (sections.length === 0) {
    throw new Error('公開可能なエージェント結果がありません');
  }

  const agentResults = sections.join('\n\n');

  try {
    // Pass 1: note.com 記事生成
    writeLog('publisher', 'note記事生成中');
    const note = await ask(NOTE_SYSTEM, agentResults, { temperature: 0.7, num_predict: 1200 });

    // Pass 2: X投稿文生成（note記事を入力にして短縮）
    writeLog('publisher', 'X投稿文生成中');
    const x = await ask(X_SYSTEM, note, { temperature: 0.5, num_predict: 200 });

    writeLog('publisher', `完了 — note: ${note.length}文字, X: ${x.length}文字`);
    return { note, x };

  } catch (err) {
    writeError('publisher', err);
    throw err;
  }
}

module.exports = { publish };
