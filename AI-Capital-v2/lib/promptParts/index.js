'use strict';

// buildNoteSystemPrompt(options) — 記事タイプ・部署構成に応じてプロンプトを動的に組み立てる。
// Phase2: 組み立てメカニズムの導入。
// Phase3: 当日 agent_recommendations に登場した部署だけを activeCharacters として渡す動的読み込みに対応。
// Phase5: lib/constitution.js（全エージェント共通の投資哲学プレフィックス。market/portfolio/risk/audit は既に使用）を
//         publisher にも統合。第1条（総合評価原則）と重複していた investmentPhilosophy.contrarianPrinciple は
//         重複箇所を削除し、固有の補足のみを残した（内容は失わずソースを一本化）。
// 2026-07-24: 逆張りAI→総合評価AIへの思想転換に伴い、contrarianTermDefinition/contrarianPrinciple/
//             observationPosition の内容を「下落=買い」の単一方向ロジックから複数指標の総合評価へ改訂。

const constitution = require('../constitution');
const articlePolicy = require('./constitution/articlePolicy');
const formatRules = require('./rules/formatRules');
const consistencyRules = require('./rules/consistencyRules');
const investmentPhilosophy = require('./constitution/investmentPhilosophy');
const generationRules = require('./rules/generationRules');
const team = require('./characters/team');
const shin = require('./characters/shin');
const misaki = require('./characters/misaki');
const aoi = require('./characters/aoi');
const gai = require('./characters/gai');
const rei = require('./characters/rei');
const sectionTemplates = require('./templates/sectionTemplates');
const outputTemplate = require('./templates/outputTemplate');
const selfAuditChecklist = require('./templates/selfAuditChecklist');

const MODULES = { articlePolicy, formatRules, consistencyRules, investmentPhilosophy, generationRules, team, shin, misaki, aoi, gai, rei, sectionTemplates, outputTemplate, selfAuditChecklist };

// 元のテンプレート文言と完全一致する順序を維持したセグメント一覧（Phase1で検証済み）。
// dimension: 'rule'（rules/*・constitution/* の各ブロック） / 'character'（characters/* のプロフィール＋対応する出力欄テンプレート）/
//            'section'（templates/* の記事構造テンプレート） / 'always'（team.js＝常時含める共通ルール）
const SEGMENTS = [
  {
    "mod": "articlePolicy",
    "key": "persona",
    "dimension": "rule",
    "filterKey": "articlePolicy"
  },
  {
    "mod": "articlePolicy",
    "key": "purpose",
    "dimension": "rule",
    "filterKey": "articlePolicy"
  },
  {
    "mod": "formatRules",
    "key": "banInternalTerms",
    "dimension": "rule",
    "filterKey": "formatRules"
  },
  {
    "mod": "formatRules",
    "key": "banEnglish",
    "dimension": "rule",
    "filterKey": "formatRules"
  },
  {
    "mod": "formatRules",
    "key": "banAiCliche",
    "dimension": "rule",
    "filterKey": "formatRules"
  },
  {
    "mod": "consistencyRules",
    "key": "deptSummaryVsRecommendation",
    "dimension": "rule",
    "filterKey": "consistencyRules"
  },
  {
    "mod": "consistencyRules",
    "key": "allDeptsWording",
    "dimension": "rule",
    "filterKey": "consistencyRules"
  },
  {
    "mod": "consistencyRules",
    "key": "finalDecisionTone",
    "dimension": "rule",
    "filterKey": "consistencyRules"
  },
  {
    "mod": "consistencyRules",
    "key": "finalDecisionAsset",
    "dimension": "rule",
    "filterKey": "consistencyRules"
  },
  {
    "mod": "investmentPhilosophy",
    "key": "disclosureSeparation",
    "dimension": "rule",
    "filterKey": "investmentPhilosophy"
  },
  {
    "mod": "investmentPhilosophy",
    "key": "cash100Definition",
    "dimension": "rule",
    "filterKey": "investmentPhilosophy"
  },
  {
    "mod": "investmentPhilosophy",
    "key": "candidateRejectionReasons",
    "dimension": "rule",
    "filterKey": "investmentPhilosophy"
  },
  {
    "mod": "investmentPhilosophy",
    "key": "contrarianTermDefinition",
    "dimension": "rule",
    "filterKey": "investmentPhilosophy"
  },
  {
    "mod": "consistencyRules",
    "key": "marketDataVerification",
    "dimension": "rule",
    "filterKey": "consistencyRules"
  },
  {
    "mod": "consistencyRules",
    "key": "unresolvableNumbers",
    "dimension": "rule",
    "filterKey": "consistencyRules"
  },
  {
    "mod": "investmentPhilosophy",
    "key": "fearGreedScale",
    "dimension": "rule",
    "filterKey": "investmentPhilosophy"
  },
  {
    "mod": "investmentPhilosophy",
    "key": "fearGreedArithmetic",
    "dimension": "rule",
    "filterKey": "investmentPhilosophy"
  },
  {
    "mod": "investmentPhilosophy",
    "key": "vixCriteria",
    "dimension": "rule",
    "filterKey": "investmentPhilosophy"
  },
  {
    "mod": "investmentPhilosophy",
    "key": "concentrationCriteria",
    "dimension": "rule",
    "filterKey": "investmentPhilosophy"
  },
  {
    "mod": "articlePolicy",
    "key": "editorialStance",
    "dimension": "rule",
    "filterKey": "articlePolicy"
  },
  {
    "mod": "articlePolicy",
    "key": "evaluationPriority",
    "dimension": "rule",
    "filterKey": "articlePolicy"
  },
  {
    "mod": "generationRules",
    "key": "varyDaily",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "generationRules",
    "key": "avoid",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "generationRules",
    "key": "encourage",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "generationRules",
    "key": "numberInterpretJudge",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "generationRules",
    "key": "actionOriented",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "investmentPhilosophy",
    "key": "observationPosition",
    "dimension": "rule",
    "filterKey": "investmentPhilosophy"
  },
  {
    "mod": "investmentPhilosophy",
    "key": "contrarianPrinciple",
    "dimension": "rule",
    "filterKey": "investmentPhilosophy"
  },
  {
    "mod": "generationRules",
    "key": "candidateVariation",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "generationRules",
    "key": "preferredEvidence",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "generationRules",
    "key": "bannedEvidence",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "generationRules",
    "key": "supplementaryEvidence",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "generationRules",
    "key": "weakReasonBan",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "generationRules",
    "key": "candidateSelectionProcess",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "generationRules",
    "key": "decisionTransparency",
    "dimension": "rule",
    "filterKey": "generationRules"
  },
  {
    "mod": "team",
    "key": "intro",
    "dimension": "always",
    "filterKey": null
  },
  {
    "mod": "team",
    "key": "dataScope",
    "dimension": "always",
    "filterKey": null
  },
  {
    "mod": "team",
    "key": "meetingFlow",
    "dimension": "always",
    "filterKey": null
  },
  {
    "mod": "team",
    "key": "conflictBalance",
    "dimension": "always",
    "filterKey": null
  },
  {
    "mod": "shin",
    "key": "profile",
    "dimension": "character",
    "filterKey": "shin"
  },
  {
    "mod": "misaki",
    "key": "profile",
    "dimension": "character",
    "filterKey": "misaki"
  },
  {
    "mod": "aoi",
    "key": "profile",
    "dimension": "character",
    "filterKey": "aoi"
  },
  {
    "mod": "gai",
    "key": "profile",
    "dimension": "character",
    "filterKey": "gai"
  },
  {
    "mod": "rei",
    "key": "profile",
    "dimension": "character",
    "filterKey": "rei"
  },
  {
    "mod": "consistencyRules",
    "key": "recommendationVsFinalAmount",
    "dimension": "rule",
    "filterKey": "consistencyRules"
  },
  {
    "mod": "formatRules",
    "key": "athGapConversion",
    "dimension": "rule",
    "filterKey": "formatRules"
  },
  {
    "mod": "sectionTemplates",
    "key": "finalDecisionRequirement",
    "dimension": "section",
    "filterKey": "finalDecisionRequirement"
  },
  {
    "mod": "outputTemplate",
    "key": "header",
    "dimension": "section",
    "filterKey": "header"
  },
  {
    "mod": "outputTemplate",
    "key": "highlightsSection",
    "dimension": "section",
    "filterKey": "highlightsSection"
  },
  {
    "mod": "outputTemplate",
    "key": "marketSection",
    "dimension": "section",
    "filterKey": "marketSection"
  },
  {
    "mod": "outputTemplate",
    "key": "candidatesSection",
    "dimension": "section",
    "filterKey": "candidatesSection"
  },
  {
    "mod": "sectionTemplates",
    "key": "deptSectionPreamble",
    "dimension": "section",
    "filterKey": "deptSectionPreamble"
  },
  {
    "mod": "sectionTemplates",
    "key": "shinOutput",
    "dimension": "character",
    "filterKey": "shin"
  },
  {
    "mod": "sectionTemplates",
    "key": "misakiOutput",
    "dimension": "character",
    "filterKey": "misaki"
  },
  {
    "mod": "sectionTemplates",
    "key": "aoiOutput",
    "dimension": "character",
    "filterKey": "aoi"
  },
  {
    "mod": "sectionTemplates",
    "key": "gaiOutput",
    "dimension": "character",
    "filterKey": "gai"
  },
  {
    "mod": "outputTemplate",
    "key": "discussionPointsSection",
    "dimension": "section",
    "filterKey": "discussionPointsSection"
  },
  {
    "mod": "outputTemplate",
    "key": "finalDecisionSection",
    "dimension": "section",
    "filterKey": "finalDecisionSection"
  },
  {
    "mod": "outputTemplate",
    "key": "fundStatusSection",
    "dimension": "section",
    "filterKey": "fundStatusSection"
  },
  {
    "mod": "outputTemplate",
    "key": "watchPointsSection",
    "dimension": "section",
    "filterKey": "watchPointsSection"
  },
  {
    "mod": "sectionTemplates",
    "key": "reiOutput",
    "dimension": "character",
    "filterKey": "rei"
  },
  {
    "mod": "outputTemplate",
    "key": "disclaimer",
    "dimension": "section",
    "filterKey": "disclaimer"
  },
  {
    "mod": "outputTemplate",
    "key": "lengthGuideline",
    "dimension": "section",
    "filterKey": "lengthGuideline"
  },
  {
    "mod": "outputTemplate",
    "key": "emojiRule",
    "dimension": "section",
    "filterKey": "emojiRule"
  },
  {
    "mod": "outputTemplate",
    "key": "markdownBan",
    "dimension": "section",
    "filterKey": "markdownBan"
  },
  {
    "mod": "outputTemplate",
    "key": "noDuplicateDept",
    "dimension": "section",
    "filterKey": "noDuplicateDept"
  },
  {
    "mod": "selfAuditChecklist",
    "key": "checklist",
    "dimension": "section",
    "filterKey": "checklist"
  }
];

const ALL_RULES = [...new Set(SEGMENTS.filter(s => s.dimension === 'rule').map(s => s.filterKey))];
const ALL_CHARACTERS = [...new Set(SEGMENTS.filter(s => s.dimension === 'character').map(s => s.filterKey))];
const ALL_SECTIONS = [...new Set(SEGMENTS.filter(s => s.dimension === 'section').map(s => s.filterKey))];

/**
 * @param {object} [options]
 * @param {string[]} [options.activeRules]      有効にするルールグループ名（rules/*・constitution/* のモジュール名）。省略時は全部。
 * @param {string[]} [options.activeCharacters] 有効にする部署名（プロフィール＋出力欄テンプレートをセットで含める）。省略時は全部。
 * @param {string[]} [options.activeDepartments] activeCharacters の別名（どちらを渡してもよい）。
 * @param {string[]} [options.activeSections]    有効にする記事セクション（見出し単位）。省略時は全部。
 * @returns {string} 組み立てられた system prompt 文字列
 */
function buildNoteSystemPrompt(options = {}) {
  const activeRules = options.activeRules || ALL_RULES;
  const activeCharacters = options.activeCharacters || options.activeDepartments || ALL_CHARACTERS;
  const activeSections = options.activeSections || ALL_SECTIONS;

  const ruleSet = new Set(activeRules);
  const charSet = new Set(activeCharacters);
  const sectionSet = new Set(activeSections);

  const parts = SEGMENTS.filter(seg => {
    if (seg.dimension === 'always') return true;
    if (seg.dimension === 'rule') return ruleSet.has(seg.filterKey);
    if (seg.dimension === 'character') return charSet.has(seg.filterKey);
    if (seg.dimension === 'section') return sectionSet.has(seg.filterKey);
    return true;
  }).map(seg => MODULES[seg.mod][seg.key]);

  // 全エージェント共通の投資哲学プレフィックス（market/portfolio/risk/audit と同じ constitution.js）を先頭に付与。
  return (constitution.prefix() + parts.join('\n\n')).trim();
}

// Phase1互換: デフォルト（全件）で組み立てた結果を静的にも export する。
const NOTE_SYSTEM_INTRO = buildNoteSystemPrompt();

module.exports = {
  buildNoteSystemPrompt,
  NOTE_SYSTEM_INTRO,
  ALL_RULES,
  ALL_CHARACTERS,
  ALL_SECTIONS,
};
