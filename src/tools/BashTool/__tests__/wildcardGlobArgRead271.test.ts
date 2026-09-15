import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
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
 * Official 2.1.271 fix B — "Fixed Bash permission checks skipping files a
 * wildcard expands to when the wildcard sits in a command's pattern or
 * option value."
 *
 * Byte-verified against the official 2.1.272 linux-x64 ELF (forensics in
 * /tmp/cc-diff-126): V4o now computes `H=bAn(e,M,n,U)` and validates
 * `fe=F==="read"?[...U,...H]:U`, where `q4o` collects every glob-containing
 * arg (`pC(arg)!==-1` — `*`, `?`, or `[` with a closing `]`) that the
 * per-command extractor did NOT return as a file path. On the legacy
 * shell-quote path (K4o → SAn with M=undefined) `bAn` reduces to exactly
 * `q4o(args, extractedPaths)` — no quote filter, no git preamble (binary:
 * `if(n===void 0||n.carveOutMayDesyncQuoteScan===!0)return d`). OCC's live
 * path IS the legacy shell-quote path (TREE_SITTER_BASH is not in the
 * feature allowlist), so the same reduction is the faithful port; the
 * dormant AST path matches official's argvUnquotedGlob-absent fallback
 * (`if(h===void 0||...)return d`), so both OCC callers get q4o semantics.
 *
 * Pre-fix gap (live): `grep -v /OUT/pass* notes.txt` — the wildcard sits in
 * grep's PATTERN position, which parsePatternCommand consumes and drops, so
 * path validation saw only `notes.txt`; with a `Bash(grep *)` allow rule the
 * command was auto-ALLOWED while the shell expanded /OUT/pass* and grep read
 * those files. Official 2.1.272 asks. Post-fix OCC asks too (the glob arg is
 * appended to the read-validation list and its base dir /OUT is outside the
 * working dirs).
 *
 * Write-behavior commands are NOT augmented (official `fe` only appends H
 * when F==="read"; for writes H feeds the Oe/Ge read-deny-rule channel that
 * OCC's narrower write pipeline does not model — appending there would
 * invent stricter-than-official asks, e.g. `tee out*`).
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

describe('2.1.271 fix B — wildcard in pattern position is read-validated', () => {
  test('grep with an OUTSIDE-workdir glob as its pattern asks (was passthrough)', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'occ-glob271-wd-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'occ-glob271-out-'))
    try {
      writeFileSync(join(workdir, 'notes.txt'), 'x')
      writeFileSync(join(outsideDir, 'passwd-1'), 'secret')
      const r = checkPathConstraints(
        { command: `grep -v ${join(outsideDir, 'pass*')} notes.txt` } as never,
        workdir,
        makePermissionContext(workdir),
        false,
        [],
      )
      expect(r.behavior).toBe('ask')
      expect((r as { message?: string }).message).toContain('was blocked')
    } finally {
      rmSync(workdir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('grep with an INSIDE-workdir glob pattern passes through (no false positive)', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'occ-glob271-wd-'))
    try {
      mkdirSync(join(workdir, 'dir'))
      writeFileSync(join(workdir, 'dir', 'a.txt'), 'x')
      writeFileSync(join(workdir, 'notes.txt'), 'x')
      const r = checkPathConstraints(
        { command: 'grep -v dir/* notes.txt' } as never,
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

  test('cat with an outside-workdir glob still asks (extractor path, no regression)', () => {
    const workdir = mkdtempSync(join(tmpdir(), 'occ-glob271-wd-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'occ-glob271-out-'))
    try {
      const r = checkPathConstraints(
        { command: `cat ${join(outsideDir, 'pass*')}` } as never,
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

  test('a glob already returned by the extractor is not duplicated into the ask', () => {
    // `sort /OUT/x*` — filterOutFlags already extracts the glob as a path;
    // q4o's dedupe Set keeps the validation list at one entry.
    const workdir = mkdtempSync(join(tmpdir(), 'occ-glob271-wd-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'occ-glob271-out-'))
    try {
      const r = checkPathConstraints(
        { command: `sort ${join(outsideDir, 'x*')} ${join(outsideDir, 'x*')}` } as never,
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
})

describe('2.1.271 fix B — LIVE pipeline: prefix allow-rule no longer waves through a pattern-position wildcard', () => {
  test('grep -v /OUT/pass* notes.txt with Bash(grep *) rule asks (was allow)', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'occ-glob271-out-'))
    try {
      writeFileSync(join(outsideDir, 'passwd-1'), 'secret')
      const r = await bashToolHasPermission(
        { command: `grep -v ${join(outsideDir, 'pass*')} notes.txt` } as never,
        makeContext(['Bash(grep *)']),
      )
      expect(r.behavior).toBe('ask')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('grep -v dir/* notes.txt with Bash(grep *) rule still allows (no false positive)', async () => {
    const r = await bashToolHasPermission(
      { command: 'grep -v dir/* notes.txt' } as never,
      makeContext(['Bash(grep *)']),
    )
    expect(r.behavior).toBe('allow')
  })
})
