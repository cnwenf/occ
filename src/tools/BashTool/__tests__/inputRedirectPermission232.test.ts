import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import type { Redirect } from '../../../utils/bash/ast.js'
import { checkPathConstraints } from '../pathValidation.js'

// The read-permission check reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (a build-time constant polyfilled in cli.tsx for runtime
// execution). Mirror that polyfill so the permission path works in tests.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * 2.1.232 alignment — Bash input redirections (`< file`) are now
 * permission-checked like their argument spellings on all platforms
 * (`grep x < secret` needs the same read access as `cat secret`).
 *
 * Official v232 checks input redirects only when AST-derived redirects are
 * available; these tests drive checkPathConstraints (the production path
 * inside bashToolHasPermission) with AST redirects exactly as
 * checkSemantics produces them.
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

describe('2.1.232 — input redirection permission checks', () => {
  let workdir: string
  let outsideDir: string

  const setup = () => {
    workdir = mkdtempSync(join(tmpdir(), 'occ-inputredir-wd-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'occ-inputredir-out-'))
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

  test('input redirect to a file OUTSIDE the working dir asks', () => {
    setup()
    try {
      const target = join(outsideDir, 'secret.txt')
      const r = checkWithRedirects(
        `cat < ${target}`,
        workdir,
        makeContext(workdir),
        [redirect('<', target)],
      )
      expect(r.behavior).toBe('ask')
      expect(r.message).toContain('Input redirection from')
      expect(r.message).toContain('may only read files')
    } finally {
      teardown()
    }
  })

  test('input redirect blocked by a Read deny rule is denied', () => {
    setup()
    try {
      const target = join(outsideDir, 'secret.txt')
      // outsideDir already starts with '/', so `Read(/${outsideDir}/**)`
      // yields the `//tmp/...` form — the `//` prefix anchors the pattern
      // at filesystem root (patternWithRoot), required for absolute paths
      // outside the settings root.
      const r = checkWithRedirects(
        `cat < ${target}`,
        workdir,
        makeContextWithDenyRule(workdir, `Read(/${outsideDir}/**)`),
        [redirect('<', target)],
      )
      expect(r.behavior).toBe('deny')
      expect(r.message).toContain('Input redirection from')
      expect(r.message).toContain('was blocked by a deny rule.')
    } finally {
      teardown()
    }
  })

  test('redirect from /dev/null is always allowed', () => {
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

  test('heredoc, herestring and fd-dup carry no file read — passthrough', () => {
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

  test('ask result without other reason carries a Read-rule suggestion', () => {
    setup()
    try {
      const target = join(outsideDir, 'secret.txt')
      const r = checkWithRedirects(
        `cat < ${target}`,
        workdir,
        makeContext(workdir),
        [redirect('<', target)],
      )
      expect(r.behavior).toBe('ask')
      if (r.behavior === 'ask') {
        expect(r.suggestions?.[0]?.type).toBe('addRules')
      }
    } finally {
      teardown()
    }
  })
})
