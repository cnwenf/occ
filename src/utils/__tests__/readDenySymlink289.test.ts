import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { isFileReadDenied } from '../attachments.js'

// MACRO.VERSION polyfill (read via getBundledSkillsRoot in the permission path).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.289 changelog #3 (security):
 *   "Fixed `Read` deny rules not applying to files @-mentioned, changed, or
 *    selected in the IDE through a symlink."
 *
 * The attachment path (IDE selection / @-mention) gates reads with
 * isFileReadDenied. Pre-fix it matched ONLY the requested spelling, so a
 * `Read(<realpath>)` deny was bypassed by @-mentioning a symlink to that
 * path. The fix checks every spelling from getPathsForPermissionCheck
 * (requested + all symlink targets) — the same set checkReadPermissionForTool
 * uses — denying if ANY matches (fail-closed).
 *
 * NOTE: official rule form for an absolute path uses a leading `//` (the
 * gitignore-style root anchor), so a real absolute path `/tmp/...` is written
 * as `Read(///tmp/...)` in rule content.
 */

const tmpDirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'occ-readeny289-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

function ctxWithDeny(rule: string) {
  return {
    ...getEmptyToolPermissionContext(),
    alwaysDenyRules: { userSettings: [rule] },
  } as never
}

describe('2.1.289 #3 — Read deny applies through a symlink (@-mention/IDE path)', () => {
  test('deny on the real path catches an @-mention of a symlink to it', () => {
    const dir = mkTmp()
    const real = join(dir, 'secret.txt')
    writeFileSync(real, 'top secret')
    const link = join(dir, 'link.txt')
    symlinkSync(real, link)

    // Deny written against the REAL target (official `//` absolute anchor).
    const ctx = ctxWithDeny(`Read(//${real})`)
    // The @-mentioned/selected path is the SYMLINK, not the real path.
    expect(isFileReadDenied(link, ctx)).toBe(true)
  })

  test('deny on the real path still catches the real path directly', () => {
    const dir = mkTmp()
    const real = join(dir, 'secret.txt')
    writeFileSync(real, 'top secret')
    const ctx = ctxWithDeny(`Read(//${real})`)
    expect(isFileReadDenied(real, ctx)).toBe(true)
  })

  test('no deny rule → not denied (through symlink)', () => {
    const dir = mkTmp()
    const real = join(dir, 'ok.txt')
    writeFileSync(real, 'fine')
    const link = join(dir, 'link.txt')
    symlinkSync(real, link)
    expect(isFileReadDenied(link, ctxWithDeny(`Read(//${dir}/other.txt)`))).toBe(
      false,
    )
  })

  test('glob deny over the containing dir catches the symlink spelling', () => {
    const dir = mkTmp()
    const real = join(dir, 'secret.txt')
    writeFileSync(real, 'top secret')
    const link = join(dir, 'link.txt')
    symlinkSync(real, link)
    const ctx = ctxWithDeny(`Read(//${dir}/**)`)
    expect(isFileReadDenied(link, ctx)).toBe(true)
  })
})
