/**
 * S24 (Claude Code 2.1.214): a hook that exits with code 2 MUST block, even
 * when its stdout JSON fails schema validation (malformed / truncated / wrong
 * shape).
 *
 * Before the fix, both hook executors short-circuited on `validationError`
 * BEFORE consulting the exit code:
 *  - `executeHooks` (main path) yielded `non_blocking_error` and returned,
 *    so the `result.status === 2` block at the `if (json)` branch was never
 *    reached.
 *  - `executeHooksOutsideREPL` threw `new Error(validationError)`, so the
 *    `blocked = result.status === 2 || !!jsonBlocked` line was never reached.
 * In both cases an exit-2 hook with malformed stdout silently failed to block
 * — a fail-open on a security-enforcement hook path.
 *
 * `exit2BlockReason` lets each executor synthesize a `blockingError` from
 * stderr when exit 2 is paired with malformed/absent JSON, so the block
 * decision happens BEFORE the validationError short-circuit. When stdout JSON
 * IS valid, it returns null — the executor's existing structured path
 * (`processHookJSONOutput` + the `if (json)` exit-2 block /
 * `blocked = result.status === 2 || !!jsonBlocked`) sets the blockingError
 * and preserves the hook's reason (regression-true).
 *
 * Mirrors the official 2.1.214 behavior: "Fixed hooks with exit code 2 not
 * blocking as documented when the hook's stdout JSON fails schema validation."
 */
export type Exit2BlockReason = {
  blockingError: string;
  command: string;
};

export function exit2BlockReason(params: {
  status: number;
  validationError?: string;
  hasJson: boolean;
  stderr: string;
  command: string;
}): Exit2BlockReason | null {
  const { status, validationError, hasJson, stderr, command } = params;
  // Only exit code 2 blocks. Other exits with malformed JSON stay a
  // non-blocking error (do NOT reverse-enlarge — case 4).
  if (status !== 2) {
    return null;
  }
  // Valid JSON: let the structured path handle the block (and keep the hook's
  // own reason/decision). Only synthesize when JSON is malformed/absent.
  if (hasJson && !validationError) {
    return null;
  }
  return {
    blockingError: `[${command}]: ${stderr || "No stderr output"}`,
    command,
  };
}
