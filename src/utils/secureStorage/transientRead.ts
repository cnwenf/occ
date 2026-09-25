/**
 * Sentinel for "strict" secure-storage reads (claude-code 2.1.281 #049).
 *
 * The official binary added `readAsyncStrict(name, {inaccessibleAs:
 * "failureIfTransient"})` (ELF @195273384). A strict read distinguishes a
 * TRANSIENT inaccessibility — the macOS login keychain is locked, so the entry
 * cannot be read *right now* but still exists — from a genuine EMPTY result
 * (unlocked, no entry). On a transient failure the read returns a sentinel
 * (`Nc` in the binary) instead of `null`.
 *
 * The credential-write merge helper (`Et` @195273515) checks for that sentinel
 * and SKIPS the write entirely:
 *
 *   if (s === Nc)
 *     return p("secure_storage_credentials_write", "read_failed_skip_write"),
 *            { success: !1, transient: !0 };
 *
 * Skipping matters because the keychain entry is a SHARED blob holding both
 * `claudeAiOauth` and `mcpOAuth` (see services/mcp/auth.ts). The pre-281 path
 * did `read() || {}` — a locked-keychain read returned `null`, so the merge
 * started from `{}`, and `update()` then either clobbered the blob (dropping
 * every `mcpOAuth` token) or, via the fallback storage's recovery branch,
 * deleted the keychain entry outright.
 *
 * This module is dependency-free so any storage backend (and the fallback
 * wrapper) can reference the sentinel without an import cycle.
 */

/**
 * Frozen singleton returned by a strict read when the backing store is
 * transiently inaccessible. Compared by identity via {@link isTransientReadFailure}.
 */
export const TRANSIENT_READ_FAILURE = Object.freeze({
  __transientSecureStorageReadFailure: true,
})

/** Type guard: true when `value` is the {@link TRANSIENT_READ_FAILURE} sentinel. */
export function isTransientReadFailure(value: unknown): boolean {
  return value === TRANSIENT_READ_FAILURE
}

/**
 * Options accepted by a strict read. Mirrors the official
 * `{inaccessibleAs:"failureIfTransient"}` argument: when set, an inaccessible
 * (locked) store is reported as {@link TRANSIENT_READ_FAILURE} rather than being
 * treated as empty.
 */
export type StrictReadOptions = {
  inaccessibleAs?: 'failureIfTransient'
}
