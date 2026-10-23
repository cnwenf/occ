/**
 * CC 2.1.309 (triage-T1-A item 3, security): session store for the file paths
 * passed via `--mcp-config`. Recorded at CLI startup (main.tsx), then consumed
 * by two protection layers:
 * - sandbox denyWrite (src/utils/sandbox/sandbox-adapter.ts) — a sandboxed
 *   command must not be able to rewrite MCP server definitions that the
 *   UNSANDBOXED client later spawns (command injection through config);
 * - the auto-edit filesystem guard (src/utils/permissions/filesystem.ts,
 *   official `Cf`) — auto-accepted edits must not modify these files either.
 *
 * Byte evidence (official 2.1.309 linux-x64 ELF, read-only):
 * - state class @239657994: `flagMcpConfigFilePaths(){return this.#n}
 *   replaceFlagMcpConfigFilePaths(e){this.#n=e}` (replace semantics)
 * - accessors @239696995: `function oSe(){return
 *   n().host.settingsSource.flagMcpConfigFilePaths()}function
 *   Ses(e){n().host.settingsSource.replaceFlagMcpConfigFilePaths(e)}`
 * - CLI collection (s2.txt @35136600+, per file-path `--mcp-config` entry):
 *   `let ge=Yt(H) …; let[Jo,Qo]=await Promise.all([rp(ge).catch(()=>{return}),
 *   np(ge).catch(()=>ge)]); if(Jo===void 0||Jo.isFile()) je.push(ge,Qo)` —
 *   stat + realpath in parallel; record resolved path AND realpath (fallback =
 *   resolved) when stat fails or the path is a regular file; after the loop
 *   `Ses(L(je))` with `L(e){return[...new Set(e)]}` (@239604093).
 *
 * STRUCTURAL DEVIATION (declared): the official state lives on the
 * host.settingsSource bootstrap class; OCC keeps it in a dedicated module
 * store instead (precedent: skippedMcpServerErrors.ts in this directory) —
 * shared src/bootstrap/state.ts is outside this work package's file list.
 * The dedup (official `L` at the call site) lives inside the setter so every
 * write path gets it. Sub-gap: the official also records `--agents` file
 * paths (`rSe()` flagAgentsFilePaths) in the same protection layers; OCC has
 * no agents-flag store — not ported here.
 */
import { realpath, stat } from 'fs/promises'

let flagMcpConfigFilePaths: string[] = []

/** Official `oSe()` — snapshot read (detached copy; immutable reads). */
export function getFlagMcpConfigFilePaths(): readonly string[] {
  return [...flagMcpConfigFilePaths]
}

/** Official `Ses(L(je))` — replace the store with a deduped list. */
export function setFlagMcpConfigFilePaths(paths: readonly string[]): void {
  flagMcpConfigFilePaths = [...new Set(paths)]
}

/**
 * Official per-entry collection gate (s2.txt @35136600+):
 * `let[Jo,Qo]=await Promise.all([rp(ge).catch(()=>{return}),
 * np(ge).catch(()=>ge)]); if(Jo===void 0||Jo.isFile()) je.push(ge,Qo)`
 * — stat + realpath in parallel; a missing path falls open (stat → undefined)
 * and realpath falls back to the input; directories are NOT recorded.
 * Returns the entries to append (resolved path + realpath spelling).
 */
export async function collectFlagMcpConfigFilePath(
  resolvedPath: string,
): Promise<string[]> {
  const [stats, realPath] = await Promise.all([
    stat(resolvedPath).catch(() => undefined),
    realpath(resolvedPath).catch(() => resolvedPath),
  ])
  if (stats === undefined || stats.isFile()) {
    return [resolvedPath, realPath]
  }
  return []
}

/** Test-only reset (module store persists across tests in one worker). */
export function resetFlagMcpConfigFilePathsForTest(): void {
  flagMcpConfigFilePaths = []
}
