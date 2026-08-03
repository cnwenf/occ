/**
 * Skipped `--mcp-config` server entries, surfaced as `mcp_server_errors` in
 * the stream-json `system/init` event (claude-code 2.1.219 item 4).
 *
 * Mirrors the binary's module-level store verbatim (2.1.220 linux-x64 ELF,
 * module `tgl` at offset ~267391527):
 *
 *   function TEm(e){wEm.push(...e)}
 *   function CEm(){return wEm}
 *   var wEm=[]
 *
 * Chain (all binary-verified):
 *   1. The CLI entry's `--mcp-config` block pushes the de-duplicated skip
 *      list here during startup parsing (binary `TEm(Zo)`).
 *   2. The QueryEngine's init builder reads it via `mcpServerErrors: CEm()`
 *      (binary offset ~267738589).
 *   3. `buildSystemInitMessage` (binary `tAr`) filters out names already in
 *      `mcpClients` and emits `mcp_server_errors` only when non-empty.
 *
 * The REPL Remote-Control bridge passes `mcpServerErrors: []` in the binary
 * (offset ~264053443), so `useReplBridge` intentionally does NOT read this
 * store.
 */

export type SkippedMcpServerError = {
  name: string
  type: string
  message: string
}

let skippedMcpServerErrors: SkippedMcpServerError[] = []

/** Binary `TEm`: append skipped entries to the module-level store. */
export function recordSkippedMcpServerErrors(
  errors: readonly SkippedMcpServerError[],
): void {
  skippedMcpServerErrors.push(...errors)
}

/** Binary `CEm`: read the store (referenced by the init-event builder). */
export function getSkippedMcpServerErrors(): readonly SkippedMcpServerError[] {
  return skippedMcpServerErrors
}

/** Test-only: reset the module store between test cases. */
export function resetSkippedMcpServerErrorsForTest(): void {
  skippedMcpServerErrors = []
}
