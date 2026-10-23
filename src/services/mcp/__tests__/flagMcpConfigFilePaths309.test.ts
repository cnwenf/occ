/**
 * CC 2.1.309 (triage-T1-A item 3, security 🔒): `--mcp-config` file paths
 * become session-protected state.
 *
 * Byte evidence (official 2.1.309, read-only):
 * - state class @239657994: `flagMcpConfigFilePaths(){return this.#n}
 *   replaceFlagMcpConfigFilePaths(e){this.#n=e}` (replace semantics)
 * - accessors @239696995: `function oSe(){return
 *   n().host.settingsSource.flagMcpConfigFilePaths()}function
 *   Ses(e){n().host.settingsSource.replaceFlagMcpConfigFilePaths(e)}`
 * - CLI collection (s2.txt @35136600+, per file-path `--mcp-config` entry):
 *   `let ge=Yt(H) …; let[Jo,Qo]=await Promise.all([rp(ge).catch(()=>{return}),
 *   np(ge).catch(()=>ge)]); if(Jo===void 0||Jo.isFile()) je.push(ge,Qo)` —
 *   stat + realpath in parallel; record resolved path AND realpath (fallback
 *   = resolved) when stat fails or the path is a regular file; after the
 *   loop `Ses(L(je))` with `L(e){return[...new Set(e)]}` (@239604093).
 *
 * OCC port: dedicated module store (precedent: skippedMcpServerErrors.ts in
 * the same directory) instead of the official host.settingsSource state
 * class — shared src/bootstrap/state.ts is outside this work package's file
 * list. Dedup (official L at the call site) lives inside the setter.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  collectFlagMcpConfigFilePath,
  getFlagMcpConfigFilePaths,
  resetFlagMcpConfigFilePathsForTest,
  setFlagMcpConfigFilePaths,
} from '../flagMcpConfigFilePaths.js'

const fixtureRoots: string[] = []

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'occ-309-mcpconfig-'))
  fixtureRoots.push(root)
  return root
}

afterEach(() => {
  resetFlagMcpConfigFilePathsForTest()
  while (fixtureRoots.length > 0) {
    rmSync(fixtureRoots.pop() as string, { recursive: true, force: true })
  }
})

describe('CC 2.1.309 item 3 — flagMcpConfigFilePaths store', () => {
  test('starts empty', () => {
    // Assert
    expect(getFlagMcpConfigFilePaths()).toEqual([])
  })

  test('setter replaces (not appends) and dedupes — official Ses(L(je))', () => {
    // Arrange
    setFlagMcpConfigFilePaths(['/a/mcp.json', '/a/mcp.json', '/b/mcp.json'])

    // Act
    setFlagMcpConfigFilePaths(['/c/mcp.json'])

    // Assert — replace semantics (replaceFlagMcpConfigFilePaths) + L dedupe
    expect(getFlagMcpConfigFilePaths()).toEqual(['/c/mcp.json'])
  })

  test('getter result is detached from the internal store', () => {
    // Arrange
    setFlagMcpConfigFilePaths(['/a/mcp.json'])

    // Act
    const snapshot = getFlagMcpConfigFilePaths()
    setFlagMcpConfigFilePaths(['/b/mcp.json'])

    // Assert — the earlier snapshot must not change (immutable reads)
    expect(snapshot).toEqual(['/a/mcp.json'])
    expect(getFlagMcpConfigFilePaths()).toEqual(['/b/mcp.json'])
  })
})

describe('CC 2.1.309 item 3 — collectFlagMcpConfigFilePath (official je.push gate)', () => {
  test('regular file records the resolved path and its realpath', async () => {
    // Arrange
    const root = makeFixtureRoot()
    const configFile = join(root, 'mcp.json')
    writeFileSync(configFile, '{"mcpServers":{}}')

    // Act
    const collected = await collectFlagMcpConfigFilePath(configFile)

    // Assert — official `je.push(ge,Qo)`: resolved path + realpath
    expect(collected).toEqual([configFile, realpathSync(configFile)])
  })

  test('directory is NOT recorded — official gate `Jo===void 0||Jo.isFile()`', async () => {
    // Arrange
    const root = makeFixtureRoot()
    const dir = join(root, 'mcp-dir')
    mkdirSync(dir)

    // Act
    const collected = await collectFlagMcpConfigFilePath(dir)

    // Assert
    expect(collected).toEqual([])
  })

  test('missing path IS recorded (stat failure falls open, realpath falls back to the path)', async () => {
    // Arrange
    const root = makeFixtureRoot()
    const missing = join(root, 'no-such-mcp.json')

    // Act
    const collected = await collectFlagMcpConfigFilePath(missing)

    // Assert — official: stat .catch(()=>undefined) → push(ge, ge-fallback)
    expect(collected).toEqual([missing, missing])
  })
})
