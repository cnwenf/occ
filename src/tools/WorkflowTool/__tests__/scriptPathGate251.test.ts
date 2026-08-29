import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { REPL_TOOL_NAME } from 'src/tools/REPLTool/constants.js'
import {
  checkScriptPathReadable,
  loadScriptGated,
  scriptPathNotReadableMessage,
  WORKFLOW_SCRIPT_MAX_BYTES,
} from '../scriptLoader.js'
import { WorkflowTool } from '../WorkflowTool.js'

/**
 * CC 2.1.251 security fix (changelog, Gap-109c): the Workflow tool's
 * `scriptPath` is now gated on the "readable set" — a scriptPath must be a
 * path the agent could already Read — and the file is re-read through a
 * TOCTOU-hardened loader (binary dtn/Wo/Ast) at checkPermissions,
 * validateInput, AND call time. Ported byte-semantically from the official
 * 2.1.251 ELF; the error strings asserted here are the binary's exact
 * strings (It/dtn/Ast), not invented ones.
 */

// The read-permission probe reaches getBundledSkillsRoot, which reads
// MACRO.VERSION; mirror the cli.tsx polyfill (same as staleReadRecovery).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const SECRET_MARKER = 'SECRET_WORKFLOW_CONTENT_do_not_leak'

const VALID_SCRIPT = `export const meta = { name: 'ok' }\nexport default async () => 1\n`

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function makeContext(opts: {
  tools?: Array<{ name: string }>
  readableDirs?: string[]
  deny?: string[]
  allow?: string[]
  ask?: string[]
  mode?: ToolPermissionContext['mode']
} = {}): ToolUseContext {
  const permContext = {
    mode: opts.mode ?? 'default',
    additionalWorkingDirectories: new Map(
      (opts.readableDirs ?? []).map(dir => [
        dir,
        { path: dir, source: 'userSettings' },
      ]),
    ),
    alwaysAllowRules: opts.allow ? { userSettings: opts.allow } : {},
    alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
    alwaysAskRules: opts.ask ? { userSettings: opts.ask } : {},
    isBypassPermissionsModeAvailable: opts.mode === 'bypassPermissions',
  } as unknown as ToolPermissionContext
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: permContext,
  }
  return {
    options: {
      tools: opts.tools ?? [{ name: FILE_READ_TOOL_NAME }],
    },
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

describe('2.1.251: Workflow scriptPath readable-set gate (Gap-109c)', () => {
  test('rejects a scriptPath outside the readable set with the byte-matched official message', async () => {
    // Arrange
    const readableDir = await makeDir('occ-109c-in-')
    const outsideDir = await makeDir('occ-109c-out-')
    const outsidePath = join(outsideDir, 'secret.js')
    await writeFile(outsidePath, `${SECRET_MARKER}\n${VALID_SCRIPT}`)
    const ctx = makeContext({ readableDirs: [readableDir] })

    // Act
    const verdict = checkScriptPathReadable(outsidePath, ctx)

    // Assert — exact It() message from the binary.
    expect(verdict).toBe(scriptPathNotReadableMessage(outsidePath))
    expect(verdict).toBe(
      'scriptPath must be a script path this tool returned, or a file you can ' +
        `already read (the working directory or a directory you have added): ${outsidePath}`,
    )
  })

  test('accepts a scriptPath inside an added working directory', async () => {
    // Arrange
    const readableDir = await makeDir('occ-109c-okdir-')
    const okPath = join(readableDir, 'ok.js')
    await writeFile(okPath, VALID_SCRIPT)
    const ctx = makeContext({ readableDirs: [readableDir] })

    // Act + Assert
    expect(checkScriptPathReadable(okPath, ctx)).toBeNull()
  })

  test('tool-list gate: no Read/REPL in a non-empty tool list rejects even readable paths', async () => {
    // Arrange — file IS in an added working directory, but the session has
    // no Read/REPL tool, so nothing can be in the readable set (binary Wo).
    const readableDir = await makeDir('occ-109c-notools-')
    const okPath = join(readableDir, 'ok.js')
    await writeFile(okPath, VALID_SCRIPT)
    const ctx = makeContext({
      readableDirs: [readableDir],
      tools: [{ name: 'Bash' }],
    })

    // Act + Assert
    expect(checkScriptPathReadable(okPath, ctx)).toBe(
      scriptPathNotReadableMessage(okPath),
    )
  })

  test('tool-list gate: REPL alone satisfies the reader requirement', async () => {
    // Arrange
    const readableDir = await makeDir('occ-109c-repl-')
    const okPath = join(readableDir, 'ok.js')
    await writeFile(okPath, VALID_SCRIPT)
    const ctx = makeContext({
      readableDirs: [readableDir],
      tools: [{ name: REPL_TOOL_NAME }],
    })

    // Act + Assert
    expect(checkScriptPathReadable(okPath, ctx)).toBeNull()
  })

  test('gated load of an outside path never leaks file content', async () => {
    // Arrange
    const readableDir = await makeDir('occ-109c-leak-in-')
    const outsideDir = await makeDir('occ-109c-leak-out-')
    const outsidePath = join(outsideDir, 'secret.js')
    await writeFile(outsidePath, `${SECRET_MARKER}\n${VALID_SCRIPT}`)
    const ctx = makeContext({ readableDirs: [readableDir] })

    // Act
    const gated = loadScriptGated(outsidePath, ctx)

    // Assert — error result, and the marker appears nowhere in it.
    expect('error' in gated).toBe(true)
    expect(JSON.stringify(gated)).not.toContain(SECRET_MARKER)
  })

  test('gated load of a readable path returns script + canonical path', async () => {
    // Arrange
    const readableDir = await makeDir('occ-109c-load-')
    const okPath = join(readableDir, 'ok.js')
    await writeFile(okPath, VALID_SCRIPT)
    const ctx = makeContext({ readableDirs: [readableDir] })

    // Act
    const gated = loadScriptGated(okPath, ctx)

    // Assert
    expect(gated).toEqual({ script: VALID_SCRIPT, path: okPath })
  })

  test('gated load of a missing readable path reports the official not-found message', async () => {
    // Arrange
    const readableDir = await makeDir('occ-109c-missing-')
    const missingPath = join(readableDir, 'nope.js')
    const ctx = makeContext({ readableDirs: [readableDir] })

    // Act
    const gated = loadScriptGated(missingPath, ctx)

    // Assert — byte-matched Ast not-found string.
    expect(gated).toEqual({
      error: `Workflow script file not found: ${missingPath}`,
    })
  })

  test('gated load enforces the 512 KiB size cap with the official message', async () => {
    // Arrange
    const readableDir = await makeDir('occ-109c-big-')
    const bigPath = join(readableDir, 'big.js')
    await writeFile(bigPath, `x`.repeat(WORKFLOW_SCRIPT_MAX_BYTES + 1))
    const ctx = makeContext({ readableDirs: [readableDir] })

    // Act
    const gated = loadScriptGated(bigPath, ctx)

    // Assert — byte-matched Ast size string (cm = 524288).
    expect(gated).toEqual({
      error: `Workflow script file ${bigPath} exceeds ${WORKFLOW_SCRIPT_MAX_BYTES} bytes`,
    })
  })

  test('symlink escape: link inside the readable set pointing outside is rejected at the canonical re-probe', async () => {
    // Arrange — the caller's path passes the gate; the symlink target does
    // not. The Ast re-probe of the canonical path must catch the escape.
    const readableDir = await makeDir('occ-109c-sym-in-')
    const outsideDir = await makeDir('occ-109c-sym-out-')
    const targetPath = join(outsideDir, 'secret.js')
    await writeFile(targetPath, `${SECRET_MARKER}\n${VALID_SCRIPT}`)
    const linkPath = join(readableDir, 'innocent.js')
    await symlink(targetPath, linkPath)
    const ctx = makeContext({ readableDirs: [readableDir] })

    // Act
    const gated = loadScriptGated(linkPath, ctx)

    // Assert — rejected, no content leak.
    expect('error' in gated).toBe(true)
    expect(JSON.stringify(gated)).not.toContain(SECRET_MARKER)
    expect((gated as { error: string }).error).toBe(
      scriptPathNotReadableMessage(linkPath),
    )
  })

  test('validateInput rejects a non-readable scriptPath with errorCode 15', async () => {
    // Arrange
    const readableDir = await makeDir('occ-109c-vi-in-')
    const outsideDir = await makeDir('occ-109c-vi-out-')
    const outsidePath = join(outsideDir, 'secret.js')
    await writeFile(outsidePath, VALID_SCRIPT)
    const ctx = makeContext({ readableDirs: [readableDir] })

    // Act
    const result = await WorkflowTool.validateInput?.(
      { scriptPath: outsidePath } as never,
      ctx,
    )

    // Assert — binary validateInput shape (errorCode 15, dtn message).
    expect(result).toEqual({
      result: false,
      message: scriptPathNotReadableMessage(outsidePath),
      errorCode: 15,
    })
  })

  test('validateInput passes a readable scriptPath', async () => {
    // Arrange
    const readableDir = await makeDir('occ-109c-vi-ok-')
    const okPath = join(readableDir, 'ok.js')
    await writeFile(okPath, VALID_SCRIPT)
    const ctx = makeContext({ readableDirs: [readableDir] })

    // Act
    const result = await WorkflowTool.validateInput?.(
      { scriptPath: okPath } as never,
      ctx,
    )

    // Assert
    expect(result).toEqual({ result: true })
  })

  test('checkPermissions: deny rule by workflow name blocks before any resolution', async () => {
    // Arrange
    const ctx = makeContext({ deny: ['Workflow(evil-flow)'] })

    // Act
    const result = await WorkflowTool.checkPermissions(
      { name: 'evil-flow' } as never,
      ctx,
    )

    // Assert — byte-matched binary deny message.
    expect(result.behavior).toBe('deny')
    expect(result.message).toBe('Workflow evil-flow blocked by permission rules')
  })

  test('checkPermissions: scriptPath outside the readable set denies without leaking content', async () => {
    // Arrange
    const readableDir = await makeDir('occ-109c-cp-in-')
    const outsideDir = await makeDir('occ-109c-cp-out-')
    const outsidePath = join(outsideDir, 'secret.js')
    await writeFile(outsidePath, `${SECRET_MARKER}\n${VALID_SCRIPT}`)
    const ctx = makeContext({ readableDirs: [readableDir] })

    // Act
    const result = await WorkflowTool.checkPermissions(
      { scriptPath: outsidePath } as never,
      ctx,
    )

    // Assert
    expect(result.behavior).toBe('deny')
    expect(result.message).toBe(scriptPathNotReadableMessage(outsidePath))
    expect(result.decisionReason).toEqual({
      type: 'other',
      reason: 'workflow scriptPath outside the readable set',
    })
    expect(JSON.stringify(result)).not.toContain(SECRET_MARKER)
  })

  test('checkPermissions: readable scriptPath asks consent and injects the loaded script', async () => {
    // Arrange
    const readableDir = await makeDir('occ-109c-cp-ok-')
    const okPath = join(readableDir, 'ok.js')
    await writeFile(okPath, VALID_SCRIPT)
    const ctx = makeContext({ readableDirs: [readableDir] })

    // Act
    const result = await WorkflowTool.checkPermissions(
      { scriptPath: okPath } as never,
      ctx,
    )

    // Assert — official consent message; gated content travels via
    // updatedInput.script so call() never re-reads an untrusted path.
    expect(result.behavior).toBe('ask')
    expect(result.message).toBe('Review dynamic workflow before running')
    expect(result.updatedInput).toEqual({ scriptPath: okPath, script: VALID_SCRIPT })
  })

  test('checkPermissions: inline script asks consent with the official message', async () => {
    // Arrange
    const ctx = makeContext()

    // Act
    const result = await WorkflowTool.checkPermissions(
      { script: VALID_SCRIPT } as never,
      ctx,
    )

    // Assert
    expect(result.behavior).toBe('ask')
    expect(result.message).toBe('Review dynamic workflow before running')
    // No name → no addRules suggestion.
    expect(result.suggestions).toBeUndefined()
  })

  test('checkPermissions: remote invocations are no longer blanket-allowed', async () => {
    // Arrange — the pre-2.1.251 OCC bypass returned allow for remote:true.
    const ctx = makeContext()

    // Act
    const result = await WorkflowTool.checkPermissions(
      { remote: true, script: VALID_SCRIPT } as never,
      ctx,
    )

    // Assert — consent still applies to every launch mode.
    expect(result.behavior).toBe('ask')
    expect(result.message).toBe('Review dynamic workflow before running')
  })
})
