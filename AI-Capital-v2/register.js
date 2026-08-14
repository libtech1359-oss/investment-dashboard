'use strict';

require('dotenv').config();

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('v2-run')
    .setDescription('[v2] パイプライン手動実行: データ→分析→投票→集約→発注→記事'),

  new SlashCommandBuilder()
    .setName('v2-article')
    .setDescription('[v2] 記事のみ再生成（Step1〜4は実行しない。既に発注済みの日を対象）')
    .addStringOption(opt =>
      opt.setName('日付')
         .setDescription('YYYY-MM-DD（省略で今日）')
         .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('v2-weekly-article')
    .setDescription('[v2] 週刊記事のみ再生成（Step1〜4・注文・portfolio_status更新・capital_events書き込みは実行しない）')
    .addStringOption(opt =>
      opt.setName('開始日')
         .setDescription('YYYY-MM-DD（省略で当週月曜）')
         .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('終了日')
         .setDescription('YYYY-MM-DD（省略で当週金曜）')
         .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('v2-status')
    .setDescription('[v2] 最新状態確認: 市場データ・最終判断・直近注文'),

  new SlashCommandBuilder()
    .setName('v2-votes')
    .setDescription('[v2] 部署投票記録を表示')
    .addStringOption(opt =>
      opt.setName('日付')
         .setDescription('YYYY-MM-DD（省略で今日）')
         .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('v2-orders')
    .setDescription('[v2] 注文履歴を表示（直近10件）'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 スラッシュコマンド登録中...');
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );
    console.log('✅ 登録完了:', commands.map(c => `/${c.name}`).join(', '));
  } catch (err) {
    console.error('❌ 登録失敗:', err.message);
  }
})();
