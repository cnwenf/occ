import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import type { Redirect } from '../../../utils/bash/ast.js'
import { checkPathConstraints } from '../pathValidation.js'

// The permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (a build-time constant polyfilled in cli.tsx for runtime
// execution). Mirror that polyfill so the permission path works in tests.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * 2.1.233 alignment (OCC-95) — upstream REVERTED the 2.1.232 Bash
 * input-redirection permission checks: "Reverted the 2.1.232 Bash
 * permission changes for Cygwin-style symlinks on Windows and for input
 * redirections (`< file`); a narrower version will return in a later
 * release". Byte-verified in the official 2.1.233 linux-x64 ELF: both
 * `op!=="<"` check loops and all "Input redirection" strings are gone.
 *
 * These tests pin the reverted behavior in OCC: `checkPathConstraints`
 * (the production seam inside bashToolHasPermission) must NOT
 * permission-check `< file` input redirections anymore, while output
 * redirection checks stay intact.
 */

function makeContext(workdir?: string): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    // allWorkingDirectories = originalCwd + additional dirs; register the
    // tmp workdir so reads inside it are in scope (as they would be for a
    // real session cwd).
    additionalWorkingDirectories: new Map(
      workdir !== undefined
        ? [[workdir, { path: workdir, source: 'userSettings' as const }]]
        : [],
    ),
  }
}

function makeContextWithDenyRule(
  workdir: string,
  ruleContent: string,
): ToolPermissionContext {
  return {
    ...makeContext(workdir),
    alwaysDenyRules: { userSettings: [ruleContent] },
  }
}

function redirect(op: Redirect['op'], target: string): Redirect {
  return { op, target }
}

function checkWithRedirects(
  command: string,
  cwd: string,
  ctx: ToolPermissionContext,
  redirects: Redirect[],
) {
  return checkPathConstraints(
    { command } as never,
    cwd,
    ctx,
    false,
    redirects,
    [], // AST commands: empty — only redirection validation under test
  )
}

describe('2.1.233 — input redirection checks reverted', () => {
  let workdir: string
  let outsideDir: string

  const setup = () => {
    workdir = mkdtempSync(join(tmpdir(), 'occ-inputredir233-wd-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'occ-inputredir233-out-'))
    writeFileSync(join(workdir, 'inside.txt'), 'in')
    writeFileSync(join(outsideDir, 'secret.txt'), 'sekrit')
  }
  const teardown = () => {
    rmSync(workdir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }

  test('input redirect to a file inside the working dir passes through', () => {
    setup()
    try {
      const r = checkWithRedirects(
        `cat < ${join(workdir, 'inside.txt')}`,
        workdir,
        makeContext(workdir),
        [redirect('<', join(workdir, 'inside.txt'))],
      )
      expect(r.behavior).toBe('passthrough')
    } finally {
      teardown()
    }
  })

  test('input redirect to a file OUTSIDE the working dir now passes through (reverted)', () => {
    setup()
    try {
      const target = join(outsideDir, 'secret.txt')
      const r = checkWithRedirects(
        `cat < ${target}`,
        workdir,
        makeContext(workdir),
        [redirect('<', target)],
      )
      // 2.1.232 asked here; upstream reverted the check in 2.1.233.
      expect(r.behavior).toBe('passthrough')
    } finally {
      teardown()
    }
  })

  test('Read deny rule no longer applies to input redirects (reverted)', () => {
    setup()
    try {
      const target = join(outsideDir, 'secret.txt')
      const r = checkWithRedirects(
        `cat < ${target}`,
        workdir,
        makeContextWithDenyRule(workdir, `Read(/${outsideDir}/**)`),
        [redirect('<', target)],
      )
      // 2.1.232 denied here; upstream reverted the check in 2.1.233.
      expect(r.behavior).toBe('passthrough')
    } finally {
      teardown()
    }
  })

  test('redirect from /dev/null passes through', () => {
    setup()
    try {
      const r = checkWithRedirects('cat < /dev/null', workdir, makeContext(), [
        redirect('<', '/dev/null'),
      ])
      expect(r.behavior).toBe('passthrough')
    } finally {
      teardown()
    }
  })

  test('heredoc, herestring and fd-dup still pass through', () => {
    setup()
    try {
      const outside = join(outsideDir, 'secret.txt')
      for (const op of ['<<', '<<<', '<&'] as const) {
        const r = checkWithRedirects('cat', workdir, makeContext(), [
          redirect(op, op === '<&' ? '0' : outside),
        ])
        expect(r.behavior).toBe('passthrough')
      }
    } finally {
      teardown()
    }
  })

  test('output redirection checks are unaffected (still create-mode)', () => {
    setup()
    try {
      const target = join(outsideDir, 'out.txt')
      const r = checkWithRedirects(
        `echo hi > ${target}`,
        workdir,
        makeContext(workdir),
        [redirect('>', target)],
      )
      expect(r.behavior).toBe('ask')
      expect(r.message).toContain('Output redirection to')
    } finally {
      teardown()
    }
  })
})
