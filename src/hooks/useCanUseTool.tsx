import { c as _c } from "react/compiler-runtime";
import { feature } from 'src/utils/featureFlags.js';
import { APIUserAbortError } from '@anthropic-ai/sdk';
import * as React from 'react';
import { useCallback } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js';
import { truncateToDisplayLength } from '../services/mcp/displaySanitize.js';
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js';
import { Text } from '../ink.js';
import type { ToolPermissionContext, Tool as ToolType, ToolUseContext } from '../Tool.js';
import { consumeSpeculativeClassifierCheck, peekSpeculativeClassifierCheck } from '../tools/BashTool/bashPermissions.js';
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js';
import { POWERSHELL_TOOL_NAME } from '../tools/PowerShellTool/toolName.js';
import type { AssistantMessage } from '../types/message.js';
import { denialInputKey, getAutoModeDenials, recordAutoModeDenial, removeAutoModeDenial } from '../utils/autoModeDenials.js';
import { clearClassifierChecking, setClassifierApproval, setYoloClassifierApproval } from '../utils/classifierApprovals.js';
import { logForDebugging } from '../utils/debug.js';
import { AbortError } from '../utils/errors.js';
import { logError } from '../utils/log.js';
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js';
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js';
import { jsonStringify } from '../utils/slowOperations.js';
import { handleCoordinatorPermission } from './toolPermission/handlers/coordinatorHandler.js';
import { handleInteractivePermission } from './toolPermission/handlers/interactiveHandler.js';
import { handleSwarmWorkerPermission } from './toolPermission/handlers/swarmWorkerHandler.js';
import { createPermissionContext, createPermissionQueueOps } from './toolPermission/PermissionContext.js';
import { logPermissionDecision } from './toolPermission/permissionLogging.js';
export type CanUseToolFn<Input extends Record<string, unknown> = Record<string, unknown>> = (tool: ToolType, input: Input, toolUseContext: ToolUseContext, assistantMessage: AssistantMessage, toolUseID: string, forceDecision?: PermissionDecision<Input>, hookAskFloor?: boolean) => Promise<PermissionDecision<Input>>;
function useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext) {
  const $ = _c(3);
  let t0;
  if ($[0] !== setToolPermissionContext || $[1] !== setToolUseConfirmQueue) {
    t0 = async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision, hookAskFloor) => {
      // CC 2.1.307 B6: official prior-denial dedup lookup (`let Pt;let bt=
      // x();if(bt.length>0){let xt=uee(Be,Ke);Pt=bt.find((Mt)=>Mt.toolName===
      // Be.name&&Mt.inputKey===xt)}`) — a retried call that was previously
      // denied is tracked so a subsequent approval removes the denial row
      // (fixes "auto-mode local classifier ignoring an approval on retried
      // command").
      let priorDenial;
      const currentDenials = getAutoModeDenials();
      if (currentDenials.length > 0) {
        const inputKey = denialInputKey(tool, input);
        priorDenial = currentDenials.find(denial => denial.toolName === tool.name && denial.inputKey === inputKey);
      }
      const promise = new Promise<PermissionDecision<Record<string, unknown>>>(resolve => {
      const ctx = createPermissionContext(tool, input, toolUseContext, assistantMessage, toolUseID, setToolPermissionContext, createPermissionQueueOps(setToolUseConfirmQueue));
      if (ctx.resolveIfAborted(resolve)) {
        return;
      }
      const decisionPromise = forceDecision !== undefined ? Promise.resolve(forceDecision) : hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseID, hookAskFloor);
      return decisionPromise.then(async result => {
        if (result.behavior === "allow") {
          if (ctx.resolveIfAborted(resolve)) {
            return;
          }
          if (feature("TRANSCRIPT_CLASSIFIER") && result.decisionReason?.type === "classifier" && result.decisionReason.classifier === "auto-mode") {
            setYoloClassifierApproval(toolUseID, result.decisionReason.reason);
          }
          ctx.logDecision({
            decision: "accept",
            source: "config",
            // CC 2.1.301 #5: the official passes `n.decisionReason` at the
            // config-sourced accept emit (u9e classifier-verdict attrs).
            decisionReason: result.decisionReason
          });
          resolve(ctx.buildAllow(result.updatedInput ?? input, {
            decisionReason: result.decisionReason
          }));
          return;
        }
        const appState = toolUseContext.getAppState();
        const description = await tool.description(input as never, {
          isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
          toolPermissionContext: appState.toolPermissionContext,
          tools: toolUseContext.options.tools
        });
        if (ctx.resolveIfAborted(resolve)) {
          return;
        }
        switch (result.behavior) {
          case "deny":
            {
              logPermissionDecision({
                tool,
                input,
                toolUseContext,
                messageId: ctx.messageId,
                toolUseID
              }, {
                decision: "reject",
                source: "config",
                // CC 2.1.301 #5: symmetric with the accept emit above.
                decisionReason: result.decisionReason
              });
              // CC 2.1.307 B6: official gate adds `||ao.decisionReason.
              // noVerdict` → return (no denial row for verdict-less denies).
              if (feature("TRANSCRIPT_CLASSIFIER") && result.decisionReason?.type === "classifier" && result.decisionReason.classifier === "auto-mode" && !result.decisionReason.noVerdict) {
                const denialReason = result.decisionReason.reason ?? "";
                // Official `Ao=Be.mcpInfo?void 0:uh.includes(Be.name)?
                // Ke.command:void 0` — shell-family non-mcp only.
                const denialCommand = tool.mcpInfo ? undefined : tool.name === BASH_TOOL_NAME || tool.name === POWERSHELL_TOOL_NAME ? (input as {
                  command?: string;
                }).command : undefined;
                recordAutoModeDenial({
                  toolName: tool.name,
                  display: description,
                  // Official `...typeof Ao==="string"&&Ao.trim()!==""&&
                  // {command:Ao},inputKey:uee(Be,Ke)`.
                  ...(typeof denialCommand === "string" && denialCommand.trim() !== "" && {
                    command: denialCommand
                  }),
                  inputKey: denialInputKey(tool, input),
                  reason: denialReason,
                  timestamp: Date.now()
                });
                // Official `go`: reason truncated to 79 units + … when the
                // reason exceeds 80; shown as a dim ` · ${go}` segment only
                // when non-empty.
                let notifReason = denialReason;
                if (notifReason.length > 80) {
                  notifReason = `${truncateToDisplayLength(notifReason, 79)}…`;
                }
                toolUseContext.addNotification?.({
                  key: "auto-mode-denied",
                  priority: "immediate",
                  jsx: <><Text color="error">{tool.userFacingName(input).toLowerCase()} denied by auto mode</Text>{notifReason ? <Text dimColor={true}>{` · ${notifReason}`}</Text> : null}<Text dimColor={true}> · /permissions</Text></>
                });
              }
              resolve(result);
              return;
            }
          case "ask":
            {
              if (appState.toolPermissionContext.awaitAutomatedChecksBeforeDialog) {
                const coordinatorDecision = await handleCoordinatorPermission({
                  ctx,
                  ...(feature("BASH_CLASSIFIER") ? {
                    pendingClassifierCheck: result.pendingClassifierCheck
                  } : {}),
                  updatedInput: result.updatedInput,
                  suggestions: result.suggestions,
                  permissionMode: appState.toolPermissionContext.mode
                });
                if (coordinatorDecision) {
                  resolve(coordinatorDecision);
                  return;
                }
              }
              if (ctx.resolveIfAborted(resolve)) {
                return;
              }
              const swarmDecision = await handleSwarmWorkerPermission({
                ctx,
                description,
                ...(feature("BASH_CLASSIFIER") ? {
                  pendingClassifierCheck: result.pendingClassifierCheck
                } : {}),
                updatedInput: result.updatedInput,
                suggestions: result.suggestions
              });
              if (swarmDecision) {
                resolve(swarmDecision);
                return;
              }
              if (feature("BASH_CLASSIFIER") && result.pendingClassifierCheck && tool.name === BASH_TOOL_NAME && !appState.toolPermissionContext.awaitAutomatedChecksBeforeDialog) {
                const speculativePromise = peekSpeculativeClassifierCheck((input as {
                  command: string;
                }).command);
                if (speculativePromise) {
                  const raceResult = await Promise.race([speculativePromise.then(_temp), new Promise(_temp2)]);
                  if (ctx.resolveIfAborted(resolve)) {
                    return;
                  }
                  if ((raceResult as any).type === "result" && (raceResult as any).result.matches && (raceResult as any).result.confidence === "high" && feature("BASH_CLASSIFIER")) {
                    consumeSpeculativeClassifierCheck((input as {
                      command: string;
                    }).command);
                    const matchedRule = (raceResult as any).result.matchedDescription ?? undefined;
                    if (matchedRule) {
                      setClassifierApproval(toolUseID, matchedRule);
                    }
                    ctx.logDecision({
                      decision: "accept",
                      source: {
                        type: "classifier"
                      }
                    });
                    resolve(ctx.buildAllow(result.updatedInput ?? input as Record<string, unknown>, {
                      decisionReason: {
                        type: "classifier" as const,
                        classifier: "bash_allow" as const,
                        reason: `Allowed by prompt rule: "${(raceResult as any).result.matchedDescription}"`
                      }
                    }));
                    return;
                  }
                }
              }
              handleInteractivePermission({
                ctx,
                description,
                result,
                awaitAutomatedChecksBeforeDialog: appState.toolPermissionContext.awaitAutomatedChecksBeforeDialog,
                bridgeCallbacks: feature("BRIDGE_MODE") ? appState.replBridgePermissionCallbacks : undefined,
                channelCallbacks: feature("KAIROS") || feature("KAIROS_CHANNELS") ? appState.channelPermissionCallbacks : undefined
              }, resolve);
              return;
            }
        }
      }).catch(error => {
        if (error instanceof AbortError || error instanceof APIUserAbortError) {
          logForDebugging(`Permission check threw ${error.constructor.name} for tool=${tool.name}: ${error.message}`);
          ctx.logCancelled();
          resolve(ctx.cancelAndAbort(undefined, true));
        } else {
          logError(error);
          resolve(ctx.cancelAndAbort(undefined, true));
        }
      }).finally(() => {
        clearClassifierChecking(toolUseID);
      });
    });
      // CC 2.1.307 B6: official subsequent-approval side effect (`if(Pt){let
      // Eo=Pt;ro.then((Yo)=>{if(Yo.behavior==="allow")i("tengu_auto_mode_
      // subsequent_approval",{...}),L(Eo)})}return ro`). The official
      // `...BBe(Be,Ge.options.mcpClients)` mcp-metadata spread is omitted
      // (OCC analytics metadata has no equivalent builder).
      if (priorDenial) {
        const denied = priorDenial;
        promise.then(decision => {
          if (decision.behavior === "allow") {
            logEvent("tengu_auto_mode_subsequent_approval", {
              toolName: sanitizeToolNameForAnalytics(tool.name) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              isMcp: tool.isMcp ?? false,
              msSinceDeny: Date.now() - denied.timestamp,
              allowReasonType: (decision.decisionReason?.type ?? "") as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
            });
            removeAutoModeDenial(denied);
          }
        });
      }
      return promise;
    };
    $[0] = setToolPermissionContext;
    $[1] = setToolUseConfirmQueue;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  return t0;
}
function _temp2(res) {
  return setTimeout(res, 2000, {
    type: "timeout" as const
  });
}
function _temp(r) {
  return {
    type: "result" as const,
    result: r
  };
}
export default useCanUseTool;
