'use strict';

const { ask }                  = require('../lib/ollama');
const { writeLog, writeError } = require('../core/logger');

const SYSTEM = `
あなたはAI投資法人「AI Capital」のマーケット分析部長です。

【役割】
- 株式市場・為替・コモディティ・暗号資産の動向分析
- マクロ経済指標の解釈
- 市場センチメントの評価

【出力形式】
以下の構造で簡潔にまとめてください：
1. 市場概況（2〜3文）
2. 注目ポイント（箇条書き3点以内）
3. 今後の見通し（1〜2文）
`.trim();

async function analyze(context) {
  writeLog('market', '分析開始');
  try {
    const content = await ask(SYSTEM, context);
    writeLog('market', `分析完了:\n${content}`);
    return { dept: 'マーケット分析部', content };
  } catch (err) {
    writeError('market', err);
    throw err;
  }
}

module.exports = { analyze };
