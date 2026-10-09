// Content for the claude-api bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import csharpClaudeApi from './claude-api/csharp/claude-api.md'
import curlExamples from './claude-api/curl/examples.md'
import goClaudeApi from './claude-api/go/claude-api.md'
import javaClaudeApi from './claude-api/java/claude-api.md'
import phpClaudeApi from './claude-api/php/claude-api.md'
import pythonAgentSdkPatterns from './claude-api/python/agent-sdk/patterns.md'
import pythonAgentSdkReadme from './claude-api/python/agent-sdk/README.md'
import pythonClaudeApiBatches from './claude-api/python/claude-api/batches.md'
import pythonClaudeApiFilesApi from './claude-api/python/claude-api/files-api.md'
import pythonClaudeApiReadme from './claude-api/python/claude-api/README.md'
import pythonClaudeApiStreaming from './claude-api/python/claude-api/streaming.md'
import pythonClaudeApiToolUse from './claude-api/python/claude-api/tool-use.md'
import rubyClaudeApi from './claude-api/ruby/claude-api.md'
import skillPrompt from './claude-api/SKILL.md'
import sharedErrorCodes from './claude-api/shared/error-codes.md'
import sharedLiveSources from './claude-api/shared/live-sources.md'
import sharedModels from './claude-api/shared/models.md'
import sharedPromptCaching from './claude-api/shared/prompt-caching.md'
import sharedToolUseConcepts from './claude-api/shared/tool-use-concepts.md'
import typescriptAgentSdkPatterns from './claude-api/typescript/agent-sdk/patterns.md'
import typescriptAgentSdkReadme from './claude-api/typescript/agent-sdk/README.md'
import typescriptClaudeApiBatches from './claude-api/typescript/claude-api/batches.md'
import typescriptClaudeApiFilesApi from './claude-api/typescript/claude-api/files-api.md'
import typescriptClaudeApiReadme from './claude-api/typescript/claude-api/README.md'
import typescriptClaudeApiStreaming from './claude-api/typescript/claude-api/streaming.md'
import typescriptClaudeApiToolUse from './claude-api/typescript/claude-api/tool-use.md'

// @[MODEL LAUNCH]: Update the model IDs/names below. These are substituted into {{VAR}}
// placeholders in the .md files at runtime before the skill prompt is sent.
// After updating these constants, manually update the two files that still hardcode models:
//   - claude-api/SKILL.md (Current Models pricing table)
//   - claude-api/shared/models.md (full model catalog with legacy versions and alias mappings)
//
// 2.1.219 Opus 5 migration (OCC-37, item 1h): official Claude Code 2.1.219 made
// `claude-opus-5` the default Opus model.
//
// 2.1.284 Sonnet 5.5 launch (OCC-101): the official 2.1.284 linux-x64 binary's
// bundled claude-api skill model-var table (`oc` block, byte-verified @230214723
// region) was migrated wholesale — Sonnet 5.5 AND Opus 5.5 are now the skill
// defaults, the v283 `OPUS_NEXT_*`/`SONNET_NEXT_*` teaser vars were dropped,
// and `PREV_SONNET_NAME` was added:
//   v283 `tc`: OPUS_ID=claude-opus-5, OPUS_NEXT_ID=claude-opus-5-5,
//     PREV_OPUS_ID=claude-opus-4-8, SONNET_ID=claude-sonnet-5,
//     SONNET_NEXT_ID=claude-sonnet-5, PREV_SONNET_ID=claude-sonnet-4-6
//   v284 `oc`: OPUS_ID=claude-opus-5-5, PREV_OPUS_ID=claude-opus-5,
//     SONNET_ID=claude-sonnet-5-5, PREV_SONNET_ID=claude-sonnet-5,
//     PREV_SONNET_NAME=Claude Sonnet 5 (no NEXT vars)
// The table below is byte-identical to the v284 `oc` block (same key order).
// Fable/Mythos/Haiku vars were already at their v284 values in v283 and are
// now registered here too (OCC previously omitted them; substitution is
// generic `{{KEY}}` so unused keys are inert). The two files the header
// comment names for manual updates (claude-api/SKILL.md pricing table,
// shared/models.md catalog) are intentional 1-byte stubs in OCC (OCC-44) —
// nothing to update there.
export const SKILL_MODEL_VARS = {
  FABLE_ID: 'claude-fable-5-1',
  FABLE_NAME: 'Claude Fable 5.1',
  MYTHOS_ID: 'claude-mythos-5-1',
  MYTHOS_NAME: 'Claude Mythos 5.1',
  PREV_FABLE_ID: 'claude-fable-5',
  PREV_FABLE_NAME: 'Claude Fable 5',
  PREV_MYTHOS_ID: 'claude-mythos-5',
  PREV_MYTHOS_NAME: 'Claude Mythos 5',
  OPUS_ID: 'claude-opus-5-5',
  OPUS_NAME: 'Claude Opus 5.5',
  PREV_OPUS_ID: 'claude-opus-5',
  PREV_OPUS_NAME: 'Claude Opus 5',
  SONNET_ID: 'claude-sonnet-5-5',
  SONNET_NAME: 'Claude Sonnet 5.5',
  // OCC-150 (2.1.293 Haiku 5.5 launch): byte-verified @48793569 — only
  // HAIKU_ID/HAIKU_NAME changed (no PREV_HAIKU_* vars exist officially).
  HAIKU_ID: 'claude-haiku-5-5',
  HAIKU_NAME: 'Claude Haiku 5.5',
  PREV_SONNET_ID: 'claude-sonnet-5',
  PREV_SONNET_NAME: 'Claude Sonnet 5',
} satisfies Record<string, string>

export const SKILL_PROMPT: string = skillPrompt

export const SKILL_FILES: Record<string, string> = {
  'csharp/claude-api.md': csharpClaudeApi,
  'curl/examples.md': curlExamples,
  'go/claude-api.md': goClaudeApi,
  'java/claude-api.md': javaClaudeApi,
  'php/claude-api.md': phpClaudeApi,
  'python/agent-sdk/README.md': pythonAgentSdkReadme,
  'python/agent-sdk/patterns.md': pythonAgentSdkPatterns,
  'python/claude-api/README.md': pythonClaudeApiReadme,
  'python/claude-api/batches.md': pythonClaudeApiBatches,
  'python/claude-api/files-api.md': pythonClaudeApiFilesApi,
  'python/claude-api/streaming.md': pythonClaudeApiStreaming,
  'python/claude-api/tool-use.md': pythonClaudeApiToolUse,
  'ruby/claude-api.md': rubyClaudeApi,
  'shared/error-codes.md': sharedErrorCodes,
  'shared/live-sources.md': sharedLiveSources,
  'shared/models.md': sharedModels,
  'shared/prompt-caching.md': sharedPromptCaching,
  'shared/tool-use-concepts.md': sharedToolUseConcepts,
  'typescript/agent-sdk/README.md': typescriptAgentSdkReadme,
  'typescript/agent-sdk/patterns.md': typescriptAgentSdkPatterns,
  'typescript/claude-api/README.md': typescriptClaudeApiReadme,
  'typescript/claude-api/batches.md': typescriptClaudeApiBatches,
  'typescript/claude-api/files-api.md': typescriptClaudeApiFilesApi,
  'typescript/claude-api/streaming.md': typescriptClaudeApiStreaming,
  'typescript/claude-api/tool-use.md': typescriptClaudeApiToolUse,
}
