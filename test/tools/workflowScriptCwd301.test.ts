/**
 * CC 2.1.301 #32 — workflow scripts asking permission (or being refused)
 * after a Bash `cd` in the same session.
 *
 * Official changelog: "Fixed workflow scripts asking for permission or being
 * refused when read, edited or re-run after a Bash `cd` in the same session."
 *
 * Binary evidence (workflow-script module region diff, v300 @238029600 vs
 * v301 @238753200): the only semantic change is the resolve base for
 * scriptPath — `No(le(),e)` → `No(de(),e)` (No = path.resolve) in both the
 * validateInput-time gate (srr→Psr) and the TOCTOU loader (LEn→$Tn); error
 * text unchanged. v300 resolved relative scriptPaths against the cd-tracked
 * cwd, so after a Bash `cd` the same script path resolved elsewhere →
 * permission ask/refusal. v301 resolves against the cd-immune session base.
 *
 * OCC mapping: getCwd() (src/utils/cwd.ts — Bash `cd` updates the tracked
 * state) → getOriginalCwd() (src/bootstrap/state.ts — the session base;
 * ExitWorktreeTool is the usage precedent).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../../src/bootstrap/state.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { FILE_READ_TOOL_NAME } from '../../src/tools/FileReadTool/prompt.js'
import {
  checkScriptPathReadable,
  loadScriptGated,
  validateScriptPath,
} from '../../src/tools/WorkflowTool/scriptLoader.js'

// The read-permission probe reaches getBundledSkillsRoot, which reads
// MACRO.VERSION; mirror the cli.tsx polyfill (same as scriptPathGate251).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const VALID_SCRIPT = `export const meta = { name: 'cd-proof' }\nexport default async () => 1\n`

const savedOriginalCwd = getOriginalCwd()
const savedCwdState = getCwdState()
const tempRoots: string[] = []

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  setOriginalCwd(savedOriginalCwd)
  setCwdState(savedCwdState)
})

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeContext(readableDirs: string[]): ToolUseContext {
  const permContext = {
    mode: 'default',
    additionalWorkingDirectories: new Map(
      readableDirs.map(dir => [dir, { path: dir, source: 'userSettings' }]),
    ),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as unknown as ToolPermissionContext
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: permContext,
  }
  return {
    options: { tools: [{ name: FILE_READ_TOOL_NAME }] },
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

describe('2.1.301 #32 — scriptPath resolves against the cd-immune session base', () => {
  test('a relative scriptPath stays readable after a simulated Bash cd', () => {
    // Arrange — session started in dirA (readable); Bash cd moved the tracked
    // cwd to dirB mid-session.
    const sessionDir = makeDir('occ-301-session-')
    const cdTargetDir = makeDir('occ-301-cd-')
    writeFileSync(join(sessionDir, 'flow.js'), VALID_SCRIPT)
    setOriginalCwd(sessionDir)
    setCwdState(cdTargetDir)
    const ctx = makeContext([sessionDir])

    // Act — the gate resolves the relative path.
    const verdict = checkScriptPathReadable('flow.js', ctx)

    // Assert — resolved against the session dir (still readable); pre-fix it
    // resolved against the post-cd dir and returned the not-readable message.
    expect(verdict).toBe(null)
  })

  test('loadScriptGated reads the relative script from the session dir after a cd', () => {
    // Arrange
    const sessionDir = makeDir('occ-301-load-')
    const cdTargetDir = makeDir('occ-301-loadcd-')
    writeFileSync(join(sessionDir, 'flow.js'), VALID_SCRIPT)
    setOriginalCwd(sessionDir)
    setCwdState(cdTargetDir)
    const ctx = makeContext([sessionDir])

    // Act
    const gated = loadScriptGated('flow.js', ctx)

    // Assert
    expect('error' in gated).toBe(false)
    if (!('error' in gated)) {
      expect(gated.script).toBe(VALID_SCRIPT)
      expect(gated.path).toBe(join(sessionDir, 'flow.js'))
    }
  })

  test('validateScriptPath resolves a relative scriptPath against the session dir, not process.cwd()', () => {
    // Arrange
    const sessionDir = makeDir('occ-301-validate-')
    const cdTargetDir = makeDir('occ-301-validatecd-')
    setOriginalCwd(sessionDir)
    setCwdState(cdTargetDir)

    // Act
    const resolved = validateScriptPath('nested/flow.js')

    // Assert
    expect(resolved).toBe(join(sessionDir, 'nested', 'flow.js'))
    expect(resolved).not.toBe(join(process.cwd(), 'nested', 'flow.js'))
  })

  test('absolute scriptPaths are unaffected by the base swap', () => {
    // Arrange
    const sessionDir = makeDir('occ-301-abs-')
    const scriptPath = join(sessionDir, 'abs-flow.js')
    writeFileSync(scriptPath, VALID_SCRIPT)
    setOriginalCwd(makeDir('occ-301-abselse-'))
    setCwdState(makeDir('occ-301-abselse2-'))
    const ctx = makeContext([sessionDir])

    // Act
    const verdict = checkScriptPathReadable(scriptPath, ctx)
    const gated = loadScriptGated(scriptPath, ctx)

    // Assert
    expect(verdict).toBe(null)
    expect('error' in gated).toBe(false)
  })
})
