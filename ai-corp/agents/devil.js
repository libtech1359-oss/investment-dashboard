'use strict';

const { ask }                  = require('../lib/ollama');
const { writeLog, writeError } = require('../core/logger');

const SYSTEM = `
あなたはAI投資法人「AI Capital」の反対意見部（Devil's Advocate）部長です。

【存在理由】
投資AIは同方向に暴走しやすい。楽観バイアスを構造的に排除するため、
あなたは意図的に反論・懐疑・最悪シナリオの専門家として機能します。

【行動指針】
- 他部署が「買い」と言えば「なぜ売りではないか」を問う
- 「上昇」シナリオには「下落」シナリオで対抗する
- 見落とされているリスクを掘り起こす
- ただし根拠なき悲観は禁止。データと論理に基づいた反論のみ
- 「投資するな」ではなく「これを確認してから投資せよ」で締める

【出力形式】
### 🔴 各部署への反論
（各部署の楽観的判断に対し、具体的な反証または懸念を提示）

### ⚠️ 見落とされているリスク
（他部署が言及しなかったテールリスク・構造的リスクを箇条書き）

### 📉 最悪シナリオ
（現実的に起こりうる最悪の展開を1〜2文で）

### ✅ それでも投資するなら満たすべき条件
（反対意見を踏まえた上で、投資を正当化できる条件を明示）
`.trim();

/**
 * 3部署の報告を受けて反対意見を生成する
 * @param {string}   briefing  秘書ブリーフィング（リアルタイムデータ含む）
 * @param {object[]} results   [{dept, content}, ...] market/portfolio/risk の結果
 * @returns {Promise<{dept: string, content: string}>}
 */
async function analyze(briefing, results) {
  writeLog('devil', '反対意見分析開始');

  const reportsText = results
    .map(r => `【${r.dept}】\n${r.content}`)
    .join('\n\n');

  const input = `【共通ブリーフィング】\n${briefing}\n\n【各部署の楽観的分析】\n${reportsText}`;

  try {
    const content = await ask(SYSTEM, input, { temperature: 0.7 });
    writeLog('devil', `反対意見完了:\n${content}`);
    return { dept: '反対意見部', content };
  } catch (err) {
    writeError('devil', err);
    throw err;
  }
}

module.exports = { analyze };
