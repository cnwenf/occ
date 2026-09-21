// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { Box, Text } from '../ink.js';
import * as React from 'react';
import { CLI_BINARY_NAME } from '../constants/cli.js';
import { getLargeMemoryFiles, getMemoryCharThreshold, type MemoryFileInfo } from './claudemd.js';
import figures from 'figures';
import { getContextWindowForModel } from './context.js';
import { getCwd } from './cwd.js';
import { relative } from 'path';
import { formatNumber } from './format.js';
import { getMainLoopModel } from './model/model.js';
import type { getGlobalConfig } from './config.js';
import { getAnthropicApiKeyWithSource, getApiKeyFromConfigOrMacOSKeychain, getAuthTokenSource, isClaudeAISubscriber } from './auth.js';
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js';
import { getAgentDescriptionsTotalTokens, AGENT_DESCRIPTIONS_THRESHOLD } from './statusNoticeHelpers.js';
import { isSupportedJetBrainsTerminal, toIDEDisplayName, getTerminalIdeType } from './ide.js';
import { isJetBrainsPluginInstalledCachedSync } from './jetbrains.js';
import { StatusIcon, getStatusColor } from '../components/design-system/StatusIcon.js';

// Gap-133b (OCC-133): the official 2.1.278 shared notice-line component `Jm`
// (decompiled ELF @217714393): a row with a width-2 icon cell and a
// growable text cell.
//   <Box flexDirection="row">
//     <Box width={2} flexShrink={0}><StatusIcon status={status}/></Box>
//     <Box flexGrow={1} flexShrink={1}>
//       <Text color={STATUS[status].color} dimColor={!color}>{children}</Text>
//     </Box>
//   </Box>
// The width-2 icon cell is what spaces the ⚠ glyph off the text in the
// official render (col 0 icon, col 2 text).
function NoticeLine(props: {
  status: StatusNoticeType;
  children: React.ReactNode;
}) {
  const color = getStatusColor(props.status);
  return <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <StatusIcon status={props.status} />
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={color} dimColor={!color}>
          {props.children}
        </Text>
      </Box>
    </Box>;
}

// Gap-133b (OCC-133): official token-source → action switch `Sne`
// (decompiled ELF @194659982), used by the both-auth-methods second bullet.
// Ported verbatim minus the `profile` case: OCC's getAuthTokenSource union
// has no 'profile' member (ant-internal `ant auth logout` surface), so that
// arm is unreachable here.
function tokenSourceActionText(source: string): string {
  switch (source) {
    case 'claude.ai':
      return `${CLI_BINARY_NAME} /logout to sign out of claude.ai.`;
    case 'apiKeyHelper':
      return 'Unset the apiKeyHelper setting.';
    case 'CCR_OAUTH_TOKEN_FILE':
      return 'This token is injected by the CCR host; check the host session.';
    case 'none':
      return '';
    default:
      return `Unset the ${source} environment variable.`;
  }
}

// Types
export type StatusNoticeType = 'warning' | 'info';
export type StatusNoticeContext = {
  config: ReturnType<typeof getGlobalConfig>;
  agentDefinitions?: AgentDefinitionsResult;
  memoryFiles: MemoryFileInfo[];
};
export type StatusNoticeDefinition = {
  id: string;
  type: StatusNoticeType;
  isActive: (context: StatusNoticeContext) => boolean;
  render: (context: StatusNoticeContext) => React.ReactNode;
};

// Individual notice definitions
const largeMemoryFilesNotice: StatusNoticeDefinition = {
  id: 'large-memory-files',
  type: 'warning',
  isActive: ctx =>
    getLargeMemoryFiles(
      ctx.memoryFiles,
      getMemoryCharThreshold(getContextWindowForModel(getMainLoopModel())),
    ).length > 0,
  render: ctx => {
    const threshold = getMemoryCharThreshold(
      getContextWindowForModel(getMainLoopModel()),
    );
    const largeMemoryFiles = getLargeMemoryFiles(ctx.memoryFiles, threshold);
    // Gap-133b (OCC-133): official 2.1.278 template (decompiled `n9t`):
    //   <Jm status="warning"><Text bold>{path}</Text> is over the
    //   {formatNumber(threshold)}-char limit ({formatNumber(len)} chars)
    //   <Text dimColor> · /memory to free up context</Text></Jm>
    return <>
        {largeMemoryFiles.map(file => {
        const displayPath = file.path.startsWith(getCwd()) ? relative(getCwd(), file.path) : file.path;
        return <NoticeLine key={file.path} status="warning">
              <Text bold>{displayPath}</Text> is over the{' '}
              {formatNumber(threshold)}-char limit (
              {formatNumber(file.content.length)} chars)
              <Text dimColor> · /memory to free up context</Text>
            </NoticeLine>;
      })}
      </>;
  }
};
const claudeAiSubscriberExternalTokenNotice: StatusNoticeDefinition = {
  id: 'claude-ai-external-token',
  type: 'warning',
  isActive: () => {
    const authTokenInfo = getAuthTokenSource();
    return isClaudeAISubscriber() && (authTokenInfo.source === 'ANTHROPIC_AUTH_TOKEN' || authTokenInfo.source === 'apiKeyHelper');
  },
  render: () => {
    const authTokenInfo = getAuthTokenSource();
    // Gap-133b (OCC-133): official 2.1.278 template (decompiled `r9t`):
    //   <Box marginTop={1}><Jm status="warning">{source} overriding Claude
    //   subscription login<Text dimColor> · unset it or /logout to sign it
    //   out</Text></Jm></Box>
    return <Box marginTop={1}>
        <NoticeLine status="warning">
          {authTokenInfo.source} overriding Claude subscription login
          <Text dimColor> · unset it or /logout to sign it out</Text>
        </NoticeLine>
      </Box>;
  }
};
const apiKeyConflictNotice: StatusNoticeDefinition = {
  id: 'api-key-conflict',
  type: 'warning',
  isActive: () => {
    const {
      source: apiKeySource
    } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    return !!getApiKeyFromConfigOrMacOSKeychain() && (apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper');
  },
  render: () => {
    const {
      source: apiKeySource
    } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    // Gap-133b (OCC-133): official 2.1.278 template (decompiled `i9t`):
    //   <Box marginTop={1}><Jm status="warning">{source} overriding saved
    //   Console key<Text dimColor> · unset it or /logout to clear the saved
    //   key</Text></Jm></Box>
    return <Box marginTop={1}>
        <NoticeLine status="warning">
          {apiKeySource} overriding saved Console key
          <Text dimColor> · unset it or /logout to clear the saved key</Text>
        </NoticeLine>
      </Box>;
  }
};
const bothAuthMethodsNotice: StatusNoticeDefinition = {
  id: 'both-auth-methods',
  type: 'warning',
  isActive: () => {
    const {
      source: apiKeySource
    } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    const authTokenInfo = getAuthTokenSource();
    return apiKeySource !== 'none' && authTokenInfo.source !== 'none' && !(apiKeySource === 'apiKeyHelper' && authTokenInfo.source === 'apiKeyHelper');
  },
  render: () => {
    const {
      source: apiKeySource
    } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true
    });
    const authTokenInfo = getAuthTokenSource();
    const tokenName = authTokenInfo.source === 'claude.ai' ? 'claude.ai' : authTokenInfo.source;
    // Gap-133b (OCC-133): official 2.1.278 structure (decompiled `s9t`,
    // live side-by-side verified):
    //   <Box flexDirection="column" marginTop={1}>
    //     <Jm status="warning">Both {tokenSource} and {keySource} set · auth
    //       may not work as expected</Jm>
    //     <Box flexDirection="column" paddingLeft={2}>
    //       <Text dimColor>· to use {tokenName}: {keyAction}</Text>
    //       <Text dimColor>· to use {keySource}: {Sne(tokenSource)}</Text>
    //     </Box>
    //   </Box>
    // The main line interpolates the RAW token source (s9t: `v.source`),
    // while bullet 1 uses the claude.ai-mapped name. The three key-action
    // tails are byte-identical to the official binary strings. The pre-fix
    // OCC wording (`Auth conflict: Both a token (…) …` / `· Trying to use
    // X? …`) has ZERO hits in the official binary.
    // Test: src/utils/__tests__/statusNoticeTemplates278.test.ts.
    return <Box flexDirection="column" marginTop={1}>
        <NoticeLine status="warning">
          Both {authTokenInfo.source} and {apiKeySource} set · auth may not
          work as expected
        </NoticeLine>
        <Box flexDirection="column" paddingLeft={2}>
          <Text dimColor>
            · to use {tokenName}:{' '}
            {apiKeySource === 'ANTHROPIC_API_KEY' ? `Unset the ANTHROPIC_API_KEY environment variable, or ${CLI_BINARY_NAME} /logout then say "No" to the API key approval before login.` : apiKeySource === 'apiKeyHelper' ? 'Unset the apiKeyHelper setting.' : `${CLI_BINARY_NAME} /logout`}
          </Text>
          <Text dimColor>
            · to use {apiKeySource}: {tokenSourceActionText(authTokenInfo.source)}
          </Text>
        </Box>
      </Box>;
  }
};
const largeAgentDescriptionsNotice: StatusNoticeDefinition = {
  id: 'large-agent-descriptions',
  type: 'warning',
  isActive: context => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions);
    return totalTokens > AGENT_DESCRIPTIONS_THRESHOLD;
  },
  render: context => {
    const totalTokens = getAgentDescriptionsTotalTokens(context.agentDefinitions);
    // Gap-133b (OCC-133): official 2.1.278 template (decompiled `a9t`,
    // threshold `bSe` = 15000 — OCC's AGENT_DESCRIPTIONS_THRESHOLD matches):
    //   <Jm status="warning">Agent descriptions are over the {ws(15000)}
    //   -token limit (~{ws(total)} tokens)<Text dimColor> · ask Claude to
    //   trim agent descriptions in .claude/agents/</Text></Jm>
    return <NoticeLine status="warning">
        Agent descriptions are over the{' '}
        {formatNumber(AGENT_DESCRIPTIONS_THRESHOLD)}-token limit (~
        {formatNumber(totalTokens)} tokens)
        <Text dimColor>
          {' '}
          · ask Claude to trim agent descriptions in .claude/agents/
        </Text>
      </NoticeLine>;
  }
};
const jetbrainsPluginNotice: StatusNoticeDefinition = {
  id: 'jetbrains-plugin-install',
  type: 'info',
  isActive: context => {
    // Only show if running in JetBrains built-in terminal
    if (!isSupportedJetBrainsTerminal()) {
      return false;
    }
    // Don't show if auto-install is disabled
    const shouldAutoInstall = context.config.autoInstallIdeExtension ?? true;
    if (!shouldAutoInstall) {
      return false;
    }
    // Check if plugin is already installed (cached to avoid repeated filesystem checks)
    const ideType = getTerminalIdeType();
    return ideType !== null && !isJetBrainsPluginInstalledCachedSync(ideType);
  },
  render: () => {
    const ideType = getTerminalIdeType();
    const ideName = toIDEDisplayName(ideType);
    return <Box flexDirection="row" gap={1} marginLeft={1}>
        <Text color="ide">{figures.arrowUp}</Text>
        <Text>
          Install the <Text color="ide">{ideName}</Text> plugin from the
          JetBrains Marketplace:{' '}
          <Text bold>https://docs.claude.com/s/claude-code-jetbrains</Text>
        </Text>
      </Box>;
  }
};

// All notice definitions
export const statusNoticeDefinitions: StatusNoticeDefinition[] = [largeMemoryFilesNotice, largeAgentDescriptionsNotice, claudeAiSubscriberExternalTokenNotice, apiKeyConflictNotice, bothAuthMethodsNotice, jetbrainsPluginNotice];

// Helper functions for external use
export function getActiveNotices(context: StatusNoticeContext): StatusNoticeDefinition[] {
  return statusNoticeDefinitions.filter(notice => notice.isActive(context));
}
