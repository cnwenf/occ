import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useInterval } from 'usehooks-ts';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import type { CommandResultDisplay } from '../../commands.js';
import { Markdown } from '../../components/Markdown.js';
import { SpinnerGlyph } from '../../components/Spinner/SpinnerGlyph.js';
import { DOWN_ARROW, UP_ARROW } from '../../constants/figures.js';
import { getSystemPrompt } from '../../constants/prompts.js';
import { useModalOrTerminalSize } from '../../context/modalContext.js';
import { getSystemContext, getUserContext } from '../../context.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import type { Message, UserMessage } from '../../types/message.js';
import { createAbortController } from '../../utils/abortController.js';
import { saveGlobalConfig } from '../../utils/config.js';
import { errorMessage } from '../../utils/errors.js';
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js';
import { type CacheSafeParams, getLastCacheSafeParams } from '../../utils/forkedAgent.js';
import { createUserMessage, getMessagesAfterCompactBoundary, isSystemLocalCommandMessage, SYNTHETIC_MODEL } from '../../utils/messages.js';
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js';
import { runSideQuestion } from '../../utils/sideQuestion.js';
import { asSystemPrompt } from '../../utils/systemPromptType.js';
type BtwComponentProps = {
  question: string;
  context: ProcessUserInputContext;
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
const CHROME_ROWS = 5;
const OUTER_CHROME_ROWS = 6;
const SCROLL_LINES = 3;
// E20 (2.1.163+2.1.187): ←/→ arrow navigation chars for the footer hint.
const LEFT_ARROW = '←'; // ←
const RIGHT_ARROW = '→'; // →

// E20: /btw keeps a session-level history of side questions so the user can
// step through earlier answers with ←/→ (matching the official 2.1.200 binary
// which renders `(+N earlier /btw)` and a `left/right` "switch" keybinding).
const btwHistory: Array<{ question: string; response: string }> = [];

/**
 * Copy raw markdown to the system clipboard. Tries the Web Clipboard API
 * first (navigator.clipboard), then falls back to platform tooling
 * (pbcopy / xclip / xsel / clip). Mirrors the official `c to copy` behavior.
 */
async function copyRawMarkdownToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to platform tooling
  }
  try {
    if (process.platform === 'win32') {
      const r = await execFileNoThrowWithCwd('clip', [], { input: text, timeout: 3000 });
      return r.code === 0;
    }
    if (process.platform === 'darwin') {
      const r = await execFileNoThrowWithCwd('pbcopy', [], { input: text, timeout: 3000 });
      return r.code === 0;
    }
    const r = await execFileNoThrowWithCwd('xclip', ['-selection', 'clipboard'], { input: text, timeout: 3000 });
    if (r.code === 0) return true;
    const r2 = await execFileNoThrowWithCwd('xsel', ['--clipboard', '--input'], { input: text, timeout: 3000 });
    return r2.code === 0;
  } catch {
    return false;
  }
}

function BtwSideQuestion({ question, context, onDone }: BtwComponentProps) {
  const [response, setResponse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  // E20: index into btwHistory being displayed. The "live" (currently
  // fetching) slot is one past the last completed entry (=== btwHistory.length).
  const [displayIndex, setDisplayIndex] = useState(() => btwHistory.length);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const { rows } = useModalOrTerminalSize(useTerminalSize());

  useInterval(() => setFrame(f => f + 1), response || error ? null : 80);

  const isLive = displayIndex >= btwHistory.length;
  const currentEntry = !isLive ? btwHistory[displayIndex] : null;
  const shownResponse = currentEntry?.response ?? (isLive ? response : null);
  const shownError = isLive ? error : null;
  const earlierCount = displayIndex;

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'escape' || e.key === 'return' || e.key === ' ' || (e.ctrl && (e.key === 'c' || e.key === 'd'))) {
      e.preventDefault();
      onDone(undefined, { display: 'skip' });
      return;
    }
    if (e.key === 'up' || (e.ctrl && e.key === 'p')) {
      e.preventDefault();
      scrollRef.current?.scrollBy(-SCROLL_LINES);
    }
    if (e.key === 'down' || (e.ctrl && e.key === 'n')) {
      e.preventDefault();
      scrollRef.current?.scrollBy(SCROLL_LINES);
    }
    // E20: c to copy raw markdown of the currently displayed answer.
    if (e.key === 'c' && !e.ctrl && shownResponse) {
      e.preventDefault();
      void copyRawMarkdownToClipboard(shownResponse).then(ok => {
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      });
    }
    // E20: ←/→ arrow navigation to step through earlier /btw answers.
    if (e.key === 'left') {
      e.preventDefault();
      setDisplayIndex(i => Math.max(0, i - 1));
      setCopied(false);
    }
    if (e.key === 'right') {
      e.preventDefault();
      setDisplayIndex(i => Math.min(btwHistory.length, i + 1));
      setCopied(false);
    }
  }

  useEffect(() => {
    const abortController = createAbortController();
    const fetchResponse = async () => {
      try {
        const turnInProgress = isTurnInProgress();
        const cacheSafeParams = await buildCacheSafeParams(context, turnInProgress);
        // Official m4e @212514171: `h=e?x(n.forkContextMessages):void 0` —
        // only synthesize the in-progress tool_result while the main
        // conversation's turn is running. runSideQuestion prepends it ahead
        // of the question ([...h?[h]:[],...w,Ae(...)]).
        const inProgressToolResultMessage = turnInProgress ? buildInProgressToolResultMessage(cacheSafeParams.forkContextMessages) : undefined;
        const result = await runSideQuestion({ question, cacheSafeParams, inProgressToolResultMessage });
        if (!abortController.signal.aborted) {
          if (result.response) {
            // E20: record in session history so ←/→ can step through earlier answers.
            btwHistory.push({ question, response: result.response });
            setResponse(result.response);
          } else {
            setError('No response received');
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          setError(errorMessage(err) || 'Failed to get response');
        }
      }
    };
    fetchResponse();
    return () => {
      abortController.abort();
    };
  }, [question, context]);

  const maxContentHeight = Math.max(5, rows - CHROME_ROWS - OUTER_CHROME_ROWS);

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1} tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>
      <Box>
        <Text color="warning" bold={true}>/btw{" "}</Text>
        <Text dimColor={true}>{question}</Text>
      </Box>
      <Box marginTop={1} marginLeft={2} maxHeight={maxContentHeight}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {shownError ? <Text color="error">{shownError}</Text> : shownResponse ? <Markdown>{shownResponse}</Markdown> : <Box><SpinnerGlyph frame={frame} messageColor="warning" /><Text color="warning">Answering...</Text></Box>}
        </ScrollBox>
      </Box>
      {earlierCount > 0 && (
        <Box marginTop={1}>
          <Text dimColor={true}>(+{earlierCount} earlier /btw)</Text>
        </Box>
      )}
      {(shownResponse || shownError) && (
        <Box marginTop={1}>
          <Text dimColor={true}>
            {UP_ARROW}/{DOWN_ARROW} to scroll · {LEFT_ARROW}/{RIGHT_ARROW} to switch · {copied ? <Text color="success">Copied to clipboard</Text> : 'c to copy'} · Space, Enter, or Escape to dismiss
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * CC 2.1.280 changelog #072: `/btw` asked while a tool is still running —
 * the side question now knows that call is in progress instead of reading it
 * as a failed one. Official v280 btw chunk @212513086 (0 hits in v278):
 *   k="[No result yet — this call is still in progress in the main
 *   conversation (running, awaiting approval, or queued)]"
 * Byte-copied (em dash included). Without this, a dangling tool_use in the
 * FORKED context got the is_error SYNTHETIC_TOOL_RESULT_PLACEHOLDER
 * ('[Tool result missing due to internal error]') injected by
 * ensureToolResultPairing in claude.ts — reading a still-running call as
 * failed. Fork-local only: ensureToolResultPairing itself is untouched.
 */
export const IN_PROGRESS_TOOL_RESULT_PLACEHOLDER = '[No result yet — this call is still in progress in the main conversation (running, awaiting approval, or queued)]';

/**
 * Port of official `tv` (v280 @194373510, chunk-zbqcwwc2 — imported by the
 * btw chunk as the message filter inside `x`):
 *   function tv(e){if(e.type==="api_system")return!1;
 *     return e.type==="progress"||e.type==="system"&&!x_e(e)||C3(e)||R3(e)
 *       ||e.type==="attachment"&&e.attachment?.type==="thinking_drop"}
 *   C3 = virtual user/assistant (isVirtual===true)
 *   R3 = synthetic api-error assistant (isApiErrorMessage===true && model===SYNTHETIC_MODEL)
 *   x_e = system local_command message
 * Excludes messages that are not part of the API-visible conversation
 * context. The official `api_system` early-return is moot in OCC — its
 * MessageType union has no 'api_system' member.
 */
function isNonContextMessage(message: Message): boolean {
  if (message.type === 'progress') return true;
  if (message.type === 'system' && !isSystemLocalCommandMessage(message)) return true;
  if ((message.type === 'user' || message.type === 'assistant') && message.isVirtual === true) return true;
  if (message.type === 'assistant' && message.isApiErrorMessage === true && message.message?.model === SYNTHETIC_MODEL) return true;
  if (message.type === 'attachment' && message.attachment?.type === 'thinking_drop') return true;
  return false;
}

/**
 * Port of official `x` (v280 @212516927, btw chunk): find the last assistant
 * message in the fork context and synthesize an isMeta user message carrying
 * an in-progress tool_result for every tool_use block that has no tool_result
 * yet. Returns undefined when nothing dangles.
 *
 *   function x(o){let n=o.filter((e)=>!tv(e)),i=n.findLast((e)=>e.type==="assistant");
 *   if(!i)return;let s=new Set,l=[];for(let e of n)if(e.type==="user"&&Array.isArray(e.message.content))
 *   {for(let t of e.message.content)if(t.type==="tool_result")s.add(t.tool_use_id)}
 *   else if(e.type==="assistant"&&e.message.id===i.message.id)
 *   {for(let t of e.message.content)if(t.type==="tool_use")l.push(t.id)}
 *   let a=l.filter((e)=>!s.has(e));if(a.length===0)return;
 *   return Ae({content:a.map((e)=>({type:"tool_result",tool_use_id:e,content:k})),isMeta:!0})}
 *
 * tool_use ids are matched by assistant message.id (not object identity)
 * because one API response can be split across several AssistantMessage
 * objects sharing the same message.id (per-content-block yielding). The
 * synthesized tool_result blocks deliberately carry NO is_error flag.
 */
export function buildInProgressToolResultMessage(messages: Message[]): UserMessage | undefined {
  const contextMessages = messages.filter(m => !isNonContextMessage(m));
  const lastAssistant = contextMessages.findLast(m => m.type === 'assistant');
  if (!lastAssistant) return undefined;
  const answeredToolUseIds = new Set<string>();
  const lastTurnToolUseIds: string[] = [];
  for (const m of contextMessages) {
    if (m.type === 'user' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (typeof block !== 'string' && block.type === 'tool_result') {
          answeredToolUseIds.add((block as { tool_use_id: string }).tool_use_id);
        }
      }
    } else if (m.type === 'assistant' && m.message?.id === lastAssistant.message?.id) {
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'string' && block.type === 'tool_use') {
            lastTurnToolUseIds.push((block as { id: string }).id);
          }
        }
      }
    }
  }
  const danglingToolUseIds = lastTurnToolUseIds.filter(id => !answeredToolUseIds.has(id));
  if (danglingToolUseIds.length === 0) return undefined;
  const content: ToolResultBlockParam[] = danglingToolUseIds.map(toolUseId => ({
    type: 'tool_result' as const,
    tool_use_id: toolUseId,
    content: IN_PROGRESS_TOOL_RESULT_PLACEHOLDER
  }));
  return createUserMessage({ content, isMeta: true });
}

/**
 * Official wDt (v280 runner module @212603046) computes `let u=p?.()??!0` —
 * the REPL passes `isTurnInProgress:()=>Ne.running` and the default is TRUE
 * when no signal is provided. OCC's ProcessUserInputContext exposes no
 * in-flight signal (QueryGuard's isQueryActive is REPL-local hook state,
 * AppState carries no such field, and REPL.tsx is outside this change's
 * file scope), so we take the official `??!0` default: true. Benign when
 * /btw is asked while idle — no trailing stop_reason===null assistant
 * exists to strip, and a fully paired transcript synthesizes nothing.
 */
function isTurnInProgress(): boolean {
  return true;
}

/**
 * Port of official `p2n` (v280 runner module @212603046):
 *   function p2n(s,o=!0){let r=s.at(-1),
 *     a=o&&r?.type==="assistant"&&r.message.stop_reason===null;
 *     return Gi(a?s.slice(0,-1):[...s])}
 * Strips the trailing streaming assistant ONLY when the turn is in progress
 * (o). When the turn has finished, the last assistant is complete and stays.
 * (Gi — the compact-boundary cut — is applied by buildCacheSafeParams via
 * getMessagesAfterCompactBoundary, matching OCC's existing composition.)
 */
export function stripInProgressAssistantMessage(messages: Message[], turnInProgress: boolean = true): Message[] {
  const last = messages.at(-1);
  const shouldStrip = turnInProgress && last?.type === 'assistant' && last.message?.stop_reason === null;
  return shouldStrip ? messages.slice(0, -1) : [...messages];
}
/**
 * Build CacheSafeParams for the side question fork.
 *
 * The preferred source is getLastCacheSafeParams — the exact
 * systemPrompt/userContext/systemContext bytes the main thread sent on its
 * last request (captured in stopHooks). Reusing them guarantees a byte-
 * identical prefix and thus a prompt cache hit. We pair these with the
 * current toolUseContext (for thinkingConfig/tools) and current messages
 * (for up-to-date context).
 *
 * Fallback (first turn before stop hooks fire, or prompt-suggestion
 * disabled): rebuild from scratch. This may miss the cache if the main loop
 * applied buildEffectiveSystemPrompt extras (--agent, --system-prompt,
 * --append-system-prompt, coordinator mode).
 *
 * `turnInProgress` gates the trailing-streaming-assistant strip (official
 * p2n's second arg) — see stripInProgressAssistantMessage.
 */
async function buildCacheSafeParams(context: ProcessUserInputContext, turnInProgress: boolean): Promise<CacheSafeParams> {
  const forkContextMessages = getMessagesAfterCompactBoundary(stripInProgressAssistantMessage(context.messages, turnInProgress));
  const saved = getLastCacheSafeParams();
  if (saved) {
    return {
      systemPrompt: saved.systemPrompt,
      userContext: saved.userContext,
      systemContext: saved.systemContext,
      toolUseContext: context,
      forkContextMessages
    };
  }
  const [rawSystemPrompt, userContext, systemContext] = await Promise.all([getSystemPrompt(context.options.tools, context.options.mainLoopModel, [], context.options.mcpClients), getUserContext(), getSystemContext()]);
  return {
    systemPrompt: asSystemPrompt(rawSystemPrompt),
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages
  };
}
export async function call(onDone: LocalJSXCommandOnDone, context: ProcessUserInputContext, args: string): Promise<React.ReactNode> {
  const question = args?.trim();
  if (!question) {
    onDone('Usage: /btw <your question>', {
      display: 'system'
    });
    return null;
  }
  saveGlobalConfig(current => ({
    ...current,
    btwUseCount: current.btwUseCount + 1
  }));
  return <BtwSideQuestion question={question} context={context} onDone={onDone} />;
}
