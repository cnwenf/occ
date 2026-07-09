import type { ReactNode } from 'react'
import type { ToolUseContext } from '../../Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

/**
 * /background — background the current session query and free the foreground
 * prompt. Mirrors official Claude Code's `/background` (`bg`): the running
 * query continues as a background task (see startBackgroundSession in
 * LocalMainSessionTask.ts) and notifies on completion.
 *
 * Previously this spawned a 'default' daemon worker via spawnWorker — wrong
 * semantics (a fresh worker, not backgrounding the live query) and the daemon
 * mechanism is stubbed in OCC.
 *
 * Implemented as `local-jsx` (not `local`) so that `immediate: true` actually
 * bypasses the query queue during a running turn (REPL.tsx:3293 only honors
 * `immediate` for `local-jsx` commands). This is the core use case —
 * backgrounding a query that is actively streaming.
 *
 * Optional prompt arg is accepted for forward-compat with official CC's
 * `[prompt]` form; the current implementation backgrounds the live messages
 * as-is.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<ReactNode> {
  if (!context.onBackgroundSession) {
    onDone(
      'Backgrounding is not available in this context (non-interactive / SDK session).',
      { display: 'system' },
    )
    return null
  }
  const prompt = args.trim()
  context.onBackgroundSession(prompt || undefined)
  onDone(
    'Session sent to background. The foreground prompt is free; you will be notified when the backgrounded query completes. Run /tasks to inspect.',
    { display: 'system' },
  )
  return null
}
