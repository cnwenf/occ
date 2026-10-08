import type { ToolResultBlockParam, ToolUseBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.mjs';
import * as React from 'react';
import { useAppStateMaybeOutsideOfProvider } from '../../state/AppState.js';
import { filterToolProgressMessages, findToolByName, type Tools } from '../../Tool.js';
import type { GroupedToolUseMessage } from '../../types/message.js';
import type { buildMessageLookups } from '../../utils/messages.js';
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js';
type Props = {
  message: GroupedToolUseMessage;
  tools: Tools;
  lookups: ReturnType<typeof buildMessageLookups>;
  inProgressToolUseIDs: Set<string>;
  shouldAnimate: boolean;
};
export function GroupedToolUseContent({
  message,
  tools,
  lookups,
  inProgressToolUseIDs,
  shouldAnimate
}: Props): React.ReactNode {
  // Official 2.1.293 #14: the grouped renderer must know which agent types are
  // actually loaded so a CUSTOM `worker` keeps its name (only a built-in or
  // unregistered `worker` collapses to "Agent"). Read reactively from the app
  // store; undefined outside a provider (falls back to collapse).
  const activeAgents = useAppStateMaybeOutsideOfProvider(
    s => s.agentDefinitions.activeAgents,
  ) as readonly AgentDefinition[] | undefined;
  const tool = findToolByName(tools, message.toolName);
  if (!tool?.renderGroupedToolUse) {
    return null;
  }

  // Build a map from tool_use_id to result data
  const resultsByToolUseId = new Map<string, {
    param: ToolResultBlockParam;
    output: unknown;
  }>();
  for (const resultMsg of message.results) {
    const contentArr = resultMsg.message.content;
    if (!Array.isArray(contentArr)) continue;
    for (const content of contentArr) {
      if (typeof content === 'string') continue;
      if (content.type === 'tool_result') {
        resultsByToolUseId.set((content as ToolResultBlockParam).tool_use_id, {
          param: content as ToolResultBlockParam,
          output: resultMsg.toolUseResult
        });
      }
    }
  }
  const toolUsesData = message.messages.map(msg => {
    const contentArr = msg.message.content;
    const rawContent = Array.isArray(contentArr) ? contentArr[0] : undefined;
    const content = rawContent as ToolUseBlockParam;
    const result = resultsByToolUseId.get(content.id);
    return {
      param: content,
      isResolved: lookups.resolvedToolUseIDs.has(content.id),
      isError: lookups.erroredToolUseIDs.has(content.id),
      isInProgress: inProgressToolUseIDs.has(content.id),
      progressMessages: filterToolProgressMessages(lookups.progressMessagesByToolUseID.get(content.id) ?? []),
      result
    };
  });
  const anyInProgress = toolUsesData.some(d => d.isInProgress);
  return tool.renderGroupedToolUse(toolUsesData, {
    shouldAnimate: shouldAnimate && anyInProgress,
    tools,
    activeAgents
  });
}
