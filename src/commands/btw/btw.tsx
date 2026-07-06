import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useInterval } from 'usehooks-ts';
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
import type { Message } from '../../types/message.js';
import { createAbortController } from '../../utils/abortController.js';
import { saveGlobalConfig } from '../../utils/config.js';
import { errorMessage } from '../../utils/errors.js';
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js';
import { type CacheSafeParams, getLastCacheSafeParams } from '../../utils/forkedAgent.js';
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js';
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
        const cacheSafeParams = await buildCacheSafeParams(context);
        const result = await runSideQuestion({ question, cacheSafeParams });
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
 */
function stripInProgressAssistantMessage(messages: Message[]): Message[] {
  const last = messages.at(-1);
  if (last?.type === 'assistant' && last.message.stop_reason === null) {
    return messages.slice(0, -1);
  }
  return messages;
}
async function buildCacheSafeParams(context: ProcessUserInputContext): Promise<CacheSafeParams> {
  const forkContextMessages = getMessagesAfterCompactBoundary(stripInProgressAssistantMessage(context.messages));
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
