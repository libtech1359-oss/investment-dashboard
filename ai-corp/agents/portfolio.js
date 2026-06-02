'use strict';

const { ask }                  = require('../lib/ollama');
const { writeLog, writeError } = require('../core/logger');

const SYSTEM = `
あなたはAI投資法人「AI Capital」のポートフォリオ管理部長です。

【役割】
- 保有資産の評価と配分最適化の提案
- 買い増し・売却タイミングの判断支援
- NISA・特定口座の活用戦略立案

【出力形式】
以下の構造で簡潔にまとめてください：
1. ポートフォリオ評価（2〜3文）
2. アクション提案（箇条書き3点以内）
3. 優先度の高い銘柄・ファンド（1〜2文）
`.trim();

async function analyze(context) {
  writeLog('portfolio', '分析開始');
  try {
    const content = await ask(SYSTEM, context);
    writeLog('portfolio', `分析完了:\n${content}`);
    return { dept: 'ポートフォリオ管理部', content };
  } catch (err) {
    writeError('portfolio', err);
    throw err;
  }
}

module.exports = { analyze };
