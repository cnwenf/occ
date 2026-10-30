/**
 * Official Claude Code 2.1.314 changelog item 62 — "Fixed the skill file
 * watcher checking every removed skill kept in `~/.claude/skills/.trash`,
 * which added file system load that grew with each removal."
 *
 * Source of truth: BIN314 watcher `ignored` callback @263295061
 * (byte-verified; the binary was never executed):
 *   ignored:(m,c)=>{if(c&&!c.isFile()&&!c.isDirectory()&&!c.isSymbolicLink())
 *   return!0;if(m.split(/[/\\]/).some((T)=>T===".git"))return!0;
 *   if(h.relative(r,m).split(h.sep)[0]===yYt)return!0;
 *   if(c?.isFile())return!m.endsWith(".md");return!1}
 * with `r=zwt("userSettings","skills")` (user skills root) and `yYt=".trash"`
 * in the enclosing setup function. BIN312 @258787631 has the identical
 * callback MINUS the `]===yYt` line — the single v314 delta for this item.
 *
 * Scope notes:
 * - OCC only ports the `.trash` skip line. The symlink allowance and the
 *   `.md` file filter already existed in BIN312 and are a pre-existing OCC
 *   divergence (out of scope for this item — reported, not ported).
 * - The official rule is relative to the USER skills root only; a project
 *   `.claude/skills/.trash` is NOT matched (faithful port, see test).
 */
import { describe, expect, test } from 'bun:test'
import * as platformPath from 'path'
import { shouldIgnoreWatchPath } from '../skillChangeDetector.js'

const USER_SKILLS_ROOT = platformPath.join(
  platformPath.sep,
  'home',
  'user',
  '.claude',
  'skills',
)

const dirStats = {
  isFile: () => false,
  isDirectory: () => true,
}
const fileStats = {
  isFile: () => true,
  isDirectory: () => false,
}
const socketStats = {
  isFile: () => false,
  isDirectory: () => false,
}

describe('2.1.314 #62 watcher .trash skip', () => {
  test('ignores paths inside the user skills .trash directory', () => {
    const path = platformPath.join(
      USER_SKILLS_ROOT,
      '.trash',
      '1700000000000-4242-oldskill',
      'SKILL.md',
    )
    expect(shouldIgnoreWatchPath(path, fileStats, USER_SKILLS_ROOT)).toBe(true)
  })

  test('ignores the .trash directory itself', () => {
    const path = platformPath.join(USER_SKILLS_ROOT, '.trash')
    expect(shouldIgnoreWatchPath(path, dirStats, USER_SKILLS_ROOT)).toBe(true)
  })

  test('does not ignore regular skill paths', () => {
    const path = platformPath.join(USER_SKILLS_ROOT, 'my-skill', 'SKILL.md')
    expect(shouldIgnoreWatchPath(path, fileStats, USER_SKILLS_ROOT)).toBe(
      false,
    )
  })

  test('does not ignore look-alike sibling directories', () => {
    const path = platformPath.join(USER_SKILLS_ROOT, '.trashy', 'SKILL.md')
    expect(shouldIgnoreWatchPath(path, fileStats, USER_SKILLS_ROOT)).toBe(
      false,
    )
  })

  test('keeps the pre-existing .git directory ignore', () => {
    const path = platformPath.join(USER_SKILLS_ROOT, 'my-skill', '.git', 'HEAD')
    expect(shouldIgnoreWatchPath(path, fileStats, USER_SKILLS_ROOT)).toBe(true)
  })

  test('keeps the pre-existing special-file-type ignore', () => {
    const path = platformPath.join(USER_SKILLS_ROOT, 'my-skill', 'sock')
    expect(shouldIgnoreWatchPath(path, socketStats, USER_SKILLS_ROOT)).toBe(
      true,
    )
  })

  test('matches only relative to the user skills root (project .trash not covered)', () => {
    // Official rule: h.relative(r,m).split(h.sep)[0]===yYt with r = user
    // skills root — a project .claude/skills/.trash resolves to '../..' first
    // segments and is NOT ignored.
    const path = platformPath.join(
      platformPath.sep,
      'proj',
      '.claude',
      'skills',
      '.trash',
      'x',
    )
    expect(shouldIgnoreWatchPath(path, dirStats, USER_SKILLS_ROOT)).toBe(false)
  })

  test('skips the .trash rule gracefully when no user skills root exists', () => {
    const path = platformPath.join('.trash', 'x')
    expect(shouldIgnoreWatchPath(path, dirStats, '')).toBe(false)
  })
})
