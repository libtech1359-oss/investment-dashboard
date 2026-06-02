/**
 * register.js
 * スラッシュコマンドを Discord に登録するスクリプト
 * 初回1回だけ実行すれば OK（コマンド追加・変更時も実行）
 * 実行方法: node register.js
 */

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('❌ .env ファイルに DISCORD_TOKEN / CLIENT_ID / GUILD_ID を設定してください');
  process.exit(1);
}

// ── スラッシュコマンドの定義 ──
const commands = [

  new SlashCommandBuilder()
    .setName('market')
    .setDescription('📊 現在の市場データを確認する（ドル円・NASDAQ・S&P500・ゴールド・BTC・Fear&Greed）'),

  new SlashCommandBuilder()
    .setName('portfolio')
    .setDescription('💼 ポートフォリオの概要を確認する（評価額・含み益・収益率）'),

  new SlashCommandBuilder()
    .setName('trades')
    .setDescription('📝 直近の取引履歴を確認する')
    .addStringOption(opt =>
      opt.setName('口座')
        .setDescription('絞り込む口座（デフォルト: 全口座）')
        .setRequired(false)
        .addChoices(
          { name: '全口座', value: 'all' },
          { name: '特定口座のみ', value: 'tokutei' },
          { name: 'NISA枠のみ（成長・積立）', value: 'nisa' },
        )
    ),

  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('🔍 各銘柄のATH比較と買い判断を表示する'),

  new SlashCommandBuilder()
    .setName('nisa')
    .setDescription('🎯 特定口座から次年度NISA移行候補を表示する')
    .addStringOption(opt =>
      opt.setName('枠')
        .setDescription('移行する NISA 枠の種類')
        .setRequired(false)
        .addChoices(
          { name: '成長投資枠 (上限¥240万)', value: 'growth' },
          { name: 'つみたて投資枠 (上限¥120万)', value: 'tsumitate' },
        )
    ),

  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('📋 現在の投資ルール状態を確認する')
    .addIntegerOption(opt =>
      opt.setName('現金')
        .setDescription('現在の現金残高（円）例: 3500000')
        .setRequired(true)
        .setMinValue(0)
    )
    .addBooleanOption(opt =>
      opt.setName('暴落モード')
        .setDescription('暴落時の特別投資枠を適用するか（デフォルト: OFF）')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('暴落枠使用済み')
        .setDescription('暴落枠のうち既に使った金額（円）例: 500000')
        .setRequired(false)
        .setMinValue(0)
    ),

].map(cmd => cmd.toJSON());

// ── Discord REST API でコマンドを登録 ──
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  console.log('⏳ スラッシュコマンドを登録中...');
  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('✅ コマンド登録完了！Discord で /market などが使えるようになります');
  } catch (err) {
    console.error('❌ コマンド登録失敗:', err.message);
  }
})();
