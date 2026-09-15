import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolPermissionContext, ToolUseContext } from '../../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../../utils/fileStateCache.js'
import { bashToolHasPermission } from '../bashPermissions.js'
import { checkPathConstraints } from '../pathValidation.js'

// The permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (build-time constant polyfilled in cli.tsx at runtime).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * Official 2.1.271 fix A — "Fixed Bash permission checks missing the file
 * that fmt, column and similar commands read when it follows an option the
 * checker doesn't recognize."
 *
 * This is verification of the coverage OCC already has after PR #375
 * (commit 5ebb375, ITEM 17: tac/rev/fold/expand/unexpand/fmt/comm/cmp/pr/
 * tsort wired into PATH_EXTRACTORS as read ops; column/cut/paste were
 * already wired). These tests pin the changelog probes so a future refactor
 * cannot silently reopen the gap — they are expected GREEN both before and
 * after the fix-B/C work in this branch.
 *
 * Why OCC is structurally immune to the official 2.1.270 bug class:
 * official's old extractor `lM` consumed the token after a KNOWN valued
 * flag even when an unknown flag preceded it, so `fmt --weird-flag --width
 * /etc/passwd` lost the file; official 2.1.272 replaced it with `$I`
 * (per-char short-opt classification with a distrust flag after unknown
 * options). OCC's `filterOutFlags` never consumes flag VALUES at all — it
 * drops every `-`-prefixed token before `--` and keeps everything else, so
 * a file following any (known or unknown) flag is always extracted →
 * validated → ask when outside the working dirs (over-inclusive =
 * fail-closed, same outcome official 2.1.272 reaches via $I).
 *
 * Boundary documented (NOT a gap): `numfmt` is deliberately excluded from
 * PATH_EXTRACTORS by #375 — verified empirically against coreutils 9.4:
 * `numfmt --invalid=ignore /etc/passwd` echoes the operand as text and
 * exits 0 without opening it (numfmt takes NUMBERs, not files), so there
 * is no read to protect. Official's QL table includes it out of caution.
 */

function makePermissionContext(workdir?: string): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    additionalWorkingDirectories: new Map(
      workdir !== undefined
        ? [[workdir, { path: workdir, source: 'userSettings' as const }]]
        : [],
    ),
  }
}

function makeContext(allowRules: string[]): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      alwaysAllowRules: { cliArg: allowRules },
    },
  } as never
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'sonnet',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appState,
    setAppState: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

describe('2.1.271 fix A — changelog probes: file after an unknown option is still read-validated', () => {
  test.each([
    'fmt --unknown-opt %s',
    'fmt --weird-flag --width %s',
    'column -t -s, --mystery %s',
    'cut -d, --mystery-flag %s',
    'tac --unknown %s',
    'fold -w40 --nope %s',
  ])('%s asks when the file is outside the working dirs', (template) => {
    const workdir = mkdtempSync(join(tmpdir(), 'occ-fixA271-wd-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'occ-fixA271-out-'))
    try {
      const outsideFile = join(outsideDir, 'secret.txt')
      writeFileSync(outsideFile, 'secret')
      const r = checkPathConstraints(
        { command: template.replace('%s', outsideFile) } as never,
        workdir,
        makePermissionContext(workdir),
        false,
        [],
      )
      expect(r.behavior).toBe('ask')
    } finally {
      rmSync(workdir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('LIVE: fmt --unknown-opt /OUT/secret.txt with Bash(fmt *) rule asks (not auto-allowed)', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'occ-fixA271-out-'))
    try {
      const outsideFile = join(outsideDir, 'secret.txt')
      writeFileSync(outsideFile, 'secret')
      const r = await bashToolHasPermission(
        { command: `fmt --unknown-opt ${outsideFile}` } as never,
        makeContext(['Bash(fmt *)']),
      )
      expect(r.behavior).toBe('ask')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('LIVE: column -t -s, --mystery /OUT/secret.txt with Bash(column *) rule asks', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'occ-fixA271-out-'))
    try {
      const outsideFile = join(outsideDir, 'secret.txt')
      writeFileSync(outsideFile, 'secret')
      const r = await bashToolHasPermission(
        { command: `column -t -s, --mystery ${outsideFile}` } as never,
        makeContext(['Bash(column *)']),
      )
      expect(r.behavior).toBe('ask')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('boundary: numfmt stays outside PATH_EXTRACTORS (does not open file operands — coreutils 9.4 verified)', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'occ-fixA271-wd-'))
    try {
      const r = checkPathConstraints(
        { command: 'numfmt --invalid=ignore 1024' } as never,
        workdir,
        makePermissionContext(workdir),
        false,
        [],
      )
      expect(r.behavior).toBe('passthrough')
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  })
})
