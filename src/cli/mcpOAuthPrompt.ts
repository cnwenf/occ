/**
 * CC 2.1.274 review P2-2 (docs/upstream-version-gap-occ128.md): the
 * `occ mcp login --no-browser` paste prompt with retry. The 274 submitter
 * returns false for a wrong-state URL and the flow KEEPS WAITING — the
 * pre-fix single-shot question discarded the boolean and closed the
 * readline, silently hanging until the 5-minute flow timeout (a regression
 * vs pre-274, where a wrong-state paste aborted immediately with a CSRF
 * error). Extracted from `src/cli/handlers/mcp.tsx` with injected IO so the
 * retry loop is unit-testable without a TTY.
 */

/**
 * Shown before re-prompting after a rejected paste. The headless control
 * channel (print.ts) sends its own variant via sendControlResponseError.
 */
export const CALLBACK_REJECTED_RETRY_HINT =
  'That URL was not accepted: its state does not match the flow in progress (or it carries no authorization code). The flow is still waiting — paste the full redirect URL from the browser page this login opened:'

export interface CallbackPromptIO {
  /** Ask one question; invoke `onAnswer` with the raw typed line. */
  question(prompt: string, onAnswer: (answer: string) => void): void
  /** Release the input interface (called exactly once, on acceptance). */
  close(): void
  /** Emit an informational line (the rejection hint). */
  notify(message: string): void
}

/**
 * Prompts until the submitter accepts a pasted callback URL.
 *
 * `submit` is the flow's manual-callback submitter: `true` = this flow
 * consumed the URL (close the prompt); `false` = rejected (wrong state /
 * not a callback URL) — notify with the retry hint and re-prompt. The flow
 * stays alive across rejections, matching the official 274 semantics.
 */
export function promptForCallbackUrlWithRetry(
  io: CallbackPromptIO,
  submit: (callbackUrl: string) => boolean,
): void {
  const ask = (): void => {
    io.question('> ', (answer: string) => {
      if (submit(answer.trim())) {
        io.close()
        return
      }
      io.notify(CALLBACK_REJECTED_RETRY_HINT)
      ask()
    })
  }
  ask()
}
