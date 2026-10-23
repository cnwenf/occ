/**
 * CC 2.1.309 (triage-T1-A item 3, security 🔒): auto-accepted edits must not
 * be able to modify `--mcp-config` files — filesystem-permission guard.
 *
 * Byte evidence (official 2.1.309, read-only, s2.txt @21164197):
 *   `function Cf(e){if(Jhe(e))return!0;let n=[...rSe(),...oSe()];
 *    if(n.length===0)return!1;let r=pw(ut(e));
 *    return n.some((s)=>pw(s)===r)}`
 * — the 309 guard wraps the pre-existing config-file check (Jhe) and adds:
 * when the flag path list is non-empty, match the lookup key
 * `pw(ut(e))` (= settingsLinkLookupKey = foldKey(expandPath(path))) against
 * every stored entry's fold key `pw(s)` (= settingsLinkFoldKey).
 * `rSe()` = flagAgentsFilePaths (official agents-flag store — NO OCC
 * counterpart, sub-gap declared in the port comment); `oSe()` =
 * flagMcpConfigFilePaths (ported as src/services/mcp/flagMcpConfigFilePaths).
 *
 * OCC port: the guard lives inside `isClaudeConfigFilePath` (the Jhe
 * analogue) in src/utils/permissions/filesystem.ts, consumed by
 * checkPathSafetyForAutoEdit's "always ask for Claude config files" branch.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetFlagMcpConfigFilePathsForTest,
  setFlagMcpConfigFilePaths,
} from '../../../services/mcp/flagMcpConfigFilePaths.js'
import { checkPathSafetyForAutoEdit } from '../filesystem.js'

const fixtureRoots: string[] = []

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'occ-309-guard-'))
  fixtureRoots.push(root)
  return root
}

afterEach(() => {
  resetFlagMcpConfigFilePathsForTest()
  while (fixtureRoots.length > 0) {
    rmSync(fixtureRoots.pop() as string, { recursive: true, force: true })
  }
})

describe('CC 2.1.309 item 3 — --mcp-config auto-edit guard (official Cf)', () => {
  test('a recorded --mcp-config file is no longer safe for auto-edit', () => {
    // Arrange
    const root = makeFixtureRoot()
    const configFile = join(root, 'mcp.json')
    writeFileSync(configFile, '{"mcpServers":{}}')
    setFlagMcpConfigFilePaths([configFile])

    // Act
    const verdict = checkPathSafetyForAutoEdit(configFile)

    // Assert — same shape as the pre-existing config-file branch
    expect(verdict.safe).toBe(false)
    if (!verdict.safe) {
      expect(verdict.classifierApprovable).toBe(true)
      expect(verdict.message).toContain("but you haven't granted it yet")
    }
  })

  test('an unrecorded file next to it stays safe', () => {
    // Arrange
    const root = makeFixtureRoot()
    const configFile = join(root, 'mcp.json')
    const otherFile = join(root, 'notes.json')
    writeFileSync(configFile, '{"mcpServers":{}}')
    writeFileSync(otherFile, '{}')
    setFlagMcpConfigFilePaths([configFile])

    // Act
    const verdict = checkPathSafetyForAutoEdit(otherFile)

    // Assert
    expect(verdict.safe).toBe(true)
  })

  test('empty store keeps plain files safe — official `if(n.length===0)return!1`', () => {
    // Arrange
    const root = makeFixtureRoot()
    const otherFile = join(root, 'notes.json')
    writeFileSync(otherFile, '{}')

    // Act
    const verdict = checkPathSafetyForAutoEdit(otherFile)

    // Assert
    expect(verdict.safe).toBe(true)
  })

  test('a redundant-segment spelling of a recorded path still matches (fold key)', () => {
    // Arrange — official compares pw(s) === pw(ut(e)): normalize-then-fold
    const root = makeFixtureRoot()
    const configFile = join(root, 'mcp.json')
    writeFileSync(configFile, '{"mcpServers":{}}')
    setFlagMcpConfigFilePaths([configFile])
    const redundantSpelling = join(root, '.', 'mcp.json')

    // Act
    const verdict = checkPathSafetyForAutoEdit(redundantSpelling)

    // Assert
    expect(verdict.safe).toBe(false)
  })
})
