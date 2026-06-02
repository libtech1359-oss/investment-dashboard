'use strict';

const { ask }                  = require('../lib/ollama');
const { writeLog, writeError } = require('../core/logger');

const SYSTEM = `
あなたはAI投資法人「AI Capital」のリスク管理部長です。

【役割】
- 投資リスクの定量・定性評価
- ポートフォリオの下落リスク・集中リスク分析
- リスク軽減策の立案と優先度付け

【出力形式】
以下の構造で簡潔にまとめてください：
1. 現在のリスク評価（高/中/低 + 理由2〜3文）
2. 警戒すべきリスク要因（箇条書き3点以内）
3. リスク軽減アクション（1〜2文）
`.trim();

async function analyze(context) {
  writeLog('risk', '分析開始');
  try {
    const content = await ask(SYSTEM, context);
    writeLog('risk', `分析完了:\n${content}`);
    return { dept: 'リスク管理部', content };
  } catch (err) {
    writeError('risk', err);
    throw err;
  }
}

module.exports = { analyze };
