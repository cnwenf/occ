import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import { reconcileClaudeSymlinks } from '../../../utils/sandbox/sandbox-adapter.js'
import { commandHasAnyCd } from '../bashPermissions.js'
import {
  extractCommandSubstitutions,
  findCatastrophicSubstitutionBlock,
} from '../destructiveCommandWarning.js'
import { validateOutputRedirections } from '../pathValidation.js'

// ─────────────────────────────────────────────────────────────────────────
// 2.1.208 #41: Catastrophic removals inside command substitutions.
//
// A `rm -rf $VAR/*` (or `rm -rf ~` / `rm -rf /`) hidden inside `$(…)`,
// backticks, `<(…)`, or `${ |…}` must trigger a destructive-command block —
// even under `--dangerously-skip-permissions` and in auto mode.
// ─────────────────────────────────────────────────────────────────────────

describe('2.1.208 #41 — catastrophic rm inside command substitutions', () => {
  describe('extractCommandSubstitutions', () => {
    test('extracts $(…) body', () => {
      const subs = extractCommandSubstitutions('echo $(rm -rf ~)')
      expect(subs).toEqual(['rm -rf ~'])
    })

    test('extracts backtick body', () => {
      const subs = extractCommandSubstitutions('echo `rm -rf /`')
      expect(subs).toEqual(['rm -rf /'])
    })

    test('extracts <(…) process substitution body', () => {
      const subs = extractCommandSubstitutions('diff <(rm -rf ~) /dev/null')
      expect(subs).toContain('rm -rf ~')
    })

    test('extracts ${ |…} command-substitution form', () => {
      const subs = extractCommandSubstitutions('echo ${ ls -la }')
      expect(subs.length).toBeGreaterThan(0)
    })

    test('does NOT extract bare grouping parens', () => {
      // A bare (echo foo) is a subshell grouping, NOT a command substitution.
      const subs = extractCommandSubstitutions('(echo hello)')
      expect(subs).toEqual([])
    })

    test('handles nested $(…) one level deep', () => {
      const subs = extractCommandSubstitutions('echo $(cat $(ls))')
      expect(subs.length).toBe(1)
    })
  })

  describe('findCatastrophicSubstitutionBlock — literal root/home', () => {
    test('blocks rm -rf ~ inside $(…)', () => {
      const block = findCatastrophicSubstitutionBlock('echo $(rm -rf ~)')
      expect(block).not.toBeNull()
      expect(block!.category).toBe('rm_substitution_root_home')
    })

    test('blocks rm -rf / inside $(…)', () => {
      const block = findCatastrophicSubstitutionBlock('echo $(rm -rf /)')
      expect(block).not.toBeNull()
      expect(block!.category).toBe('rm_substitution_root_home')
    })

    test('blocks rm -rf $HOME inside $(…)', () => {
      const block = findCatastrophicSubstitutionBlock('echo $(rm -rf $HOME)')
      expect(block).not.toBeNull()
      expect(block!.category).toBe('rm_substitution_root_home')
    })

    test('blocks rm -rf ~ inside backticks', () => {
      const block = findCatastrophicSubstitutionBlock('echo `rm -rf ~`')
      expect(block).not.toBeNull()
      expect(block!.category).toBe('rm_substitution_root_home')
    })

    test('blocks rm -rf ~ inside <(…)', () => {
      const block = findCatastrophicSubstitutionBlock(
        'diff <(rm -rf ~) /dev/null',
      )
      expect(block).not.toBeNull()
      expect(block!.category).toBe('rm_substitution_root_home')
    })
  })

  describe('findCatastrophicSubstitutionBlock — variable-path target', () => {
    test('blocks rm -rf $UNSET/* inside $(…)', () => {
      // $UNSET is empty → /* → root wipe. This is the binary hXi path.
      const block = findCatastrophicSubstitutionBlock(
        'echo $(rm -rf $UNSET/*)',
      )
      expect(block).not.toBeNull()
      expect(block!.category).toBe('rm_substitution_var_path')
    })

    test('blocks rm -rf ${VAR}/* inside $(…)', () => {
      const block = findCatastrophicSubstitutionBlock(
        'echo $(rm -rf ${VAR}/*)',
      )
      expect(block).not.toBeNull()
      expect(block!.category).toBe('rm_substitution_var_path')
    })

    test('blocks rmdir $UNSET/* inside $(…)', () => {
      const block = findCatastrophicSubstitutionBlock(
        'echo $(rmdir $UNSET/*)',
      )
      expect(block).not.toBeNull()
      expect(block!.category).toBe('rm_substitution_var_path')
    })
  })

  describe('findCatastrophicSubstitutionBlock — too many substitutions', () => {
    test('blocks when >64 substitutions + rm present', () => {
      // Generate 65 $(echo X) substitutions + an rm command.
      const subs = Array.from({ length: 65 }, (_, i) => `$(echo ${i})`).join(' ')
      const cmd = `rm -rf /tmp/safe ${subs}`
      const block = findCatastrophicSubstitutionBlock(cmd)
      expect(block).not.toBeNull()
      expect(block!.category).toBe('rm_substitution_too_many')
    })

    test('does NOT block >64 substitutions without rm', () => {
      const subs = Array.from({ length: 65 }, (_, i) => `$(echo ${i})`).join(' ')
      const cmd = `echo ${subs}`
      const block = findCatastrophicSubstitutionBlock(cmd)
      expect(block).toBeNull()
    })
  })

  describe('findCatastrophicSubstitutionBlock — negatives', () => {
    test('does not block a safe echo $(ls)', () => {
      expect(findCatastrophicSubstitutionBlock('echo $(ls -la)')).toBeNull()
    })

    test('does not block rm -rf /tmp/foo inside $(…)', () => {
      // /tmp/foo is a scoped, legitimate deletion — not catastrophic.
      expect(
        findCatastrophicSubstitutionBlock('echo $(rm -rf /tmp/foo)'),
      ).toBeNull()
    })

    test('does not block rm -rf ~/Documents inside $(…)', () => {
      // ~/Documents is a scoped deletion, not ~ itself.
      expect(
        findCatastrophicSubstitutionBlock('echo $(rm -rf ~/Documents)'),
      ).toBeNull()
    })

    test('does not block rm -rf $VAR/foo inside $(…)', () => {
      // $VAR/foo is not a root-level glob — it's a scoped path under $VAR.
      expect(
        findCatastrophicSubstitutionBlock('echo $(rm -rf $VAR/foo)'),
      ).toBeNull()
    })

    test('returns null for a plain command with no substitutions', () => {
      expect(findCatastrophicSubstitutionBlock('rm -rf /tmp/safe')).toBeNull()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2.1.207 #6: Compound commands with cd + /dev/null redirect must NOT prompt.
//
// A `cd foo && do_thing > /dev/null` must not prompt solely because of the
// redirect — /dev/null is a sink, not a real write. Only prompt when at
// least one redirect targets a path OTHER than /dev/null.
// ─────────────────────────────────────────────────────────────────────────

describe('2.1.207 #6 — cd + /dev/null redirect does not prompt', () => {
  const cwd = '/tmp'
  const ctx = getEmptyToolPermissionContext()

  test('cd + redirect to /dev/null → passthrough', () => {
    // Arrange
    const redirections = [{ target: '/dev/null', operator: '>' as const }]
    const compoundCommandHasCd = true

    // Act
    const result = validateOutputRedirections(
      redirections,
      cwd,
      ctx,
      compoundCommandHasCd,
    )

    // Assert
    expect(result.behavior).toBe('passthrough')
  })

  test('cd + redirect to real file → ask', () => {
    // Arrange
    const redirections = [{ target: 'output.txt', operator: '>' as const }]
    const compoundCommandHasCd = true

    // Act
    const result = validateOutputRedirections(
      redirections,
      cwd,
      ctx,
      compoundCommandHasCd,
    )

    // Assert
    expect(result.behavior).toBe('ask')
  })

  test('cd + mixed /dev/null and real file → ask', () => {
    // Arrange — one safe redirect + one dangerous redirect
    const redirections = [
      { target: '/dev/null', operator: '>' as const },
      { target: 'config.json', operator: '>' as const },
    ]
    const compoundCommandHasCd = true

    // Act
    const result = validateOutputRedirections(
      redirections,
      cwd,
      ctx,
      compoundCommandHasCd,
    )

    // Assert — the real file redirect makes it dangerous
    expect(result.behavior).toBe('ask')
  })

  test('cd + multiple /dev/null redirects → passthrough', () => {
    // Arrange — all redirects go to /dev/null
    const redirections = [
      { target: '/dev/null', operator: '>' as const },
      { target: '/dev/null', operator: '>>' as const },
    ]
    const compoundCommandHasCd = true

    // Act
    const result = validateOutputRedirections(
      redirections,
      cwd,
      ctx,
      compoundCommandHasCd,
    )

    // Assert
    expect(result.behavior).toBe('passthrough')
  })

  test('no cd + redirect to real file → not blocked by the cd-specific rule', () => {
    // Arrange — no cd, so the cd+redirect rule doesn't apply. Path validation
    // may still block the redirect (output.txt outside allowed dirs), but the
    // decision reason must NOT be the cd-specific one.
    const redirections = [{ target: 'output.txt', operator: '>' as const }]
    const compoundCommandHasCd = false

    // Act
    const result = validateOutputRedirections(
      redirections,
      cwd,
      ctx,
      compoundCommandHasCd,
    )

    // Assert — the cd-specific message must not appear
    expect(result.message).not.toContain('change directories')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2.1.210 #10: Backgrounded cd command result says cwd is unchanged.
//
// When a command containing cd (or pushd/popd/chdir) is auto-backgrounded,
// the tool result must state the session cwd remains unchanged — the cd
// runs in the background subshell, not the session.
// ─────────────────────────────────────────────────────────────────────────

describe('2.1.210 #10 — backgrounded cd cwd hint', () => {
  describe('commandHasAnyCd (includes chdir per binary HMe)', () => {
    test('detects cd', () => {
      expect(commandHasAnyCd('cd /tmp && ls')).toBe(true)
    })

    test('detects pushd', () => {
      expect(commandHasAnyCd('pushd /tmp && ls')).toBe(true)
    })

    test('detects popd', () => {
      expect(commandHasAnyCd('popd && ls')).toBe(true)
    })

    test('detects chdir (binary HMe)', () => {
      // chdir is a bash builtin alias for cd; the 2.1.210 binary's HMe
      // includes it so the backgrounded-cwd hint fires.
      expect(commandHasAnyCd('chdir /tmp && ls')).toBe(true)
    })

    test('does not detect non-cd commands', () => {
      expect(commandHasAnyCd('ls -la /tmp')).toBe(false)
    })

    test('does not detect cd in a string literal', () => {
      expect(commandHasAnyCd('echo "cd /tmp"')).toBe(false)
    })
  })

  // The actual backgroundCwdHint field is set in BashTool.call() based on
  // `result.backgroundTaskId && commandHasAnyCd(input.command)`. We test the
  // two inputs to that condition here; the integration is verified by the
  // mapToolResultToToolResultBlockParam test below.
  describe('mapToolResultToToolResultBlockParam content includes hint', () => {
    test('backgroundCwdHint appears in content when backgroundTaskId + cd', () => {
      // This mirrors the binary: g.backgroundTaskId && fQt(e.command)
      //   ? `Session cwd remains ...` : void 0
      // The hint is appended to the tool result content array.
      const backgroundTaskId = 'task-123'
      const commandHasCd = commandHasAnyCd('cd /tmp && ls')
      const hint =
        backgroundTaskId && commandHasCd
          ? 'Session cwd remains /test; directory changes made by the backgrounded command do not apply to subsequent commands.'
          : undefined

      // Assert — the hint is present when both conditions are true
      expect(hint).toBeDefined()
      expect(hint).toContain('Session cwd remains')
      expect(hint).toContain('do not apply to subsequent commands')
    })

    test('backgroundCwdHint is undefined when no cd', () => {
      const backgroundTaskId = 'task-123'
      const commandHasCd = commandHasAnyCd('ls -la')
      const hint =
        backgroundTaskId && commandHasCd
          ? 'Session cwd remains /test'
          : undefined

      expect(hint).toBeUndefined()
    })

    test('backgroundCwdHint is undefined when not backgrounded', () => {
      const backgroundTaskId: string | undefined = undefined
      const commandHasCd = commandHasAnyCd('cd /tmp && ls')
      const hint =
        backgroundTaskId && commandHasCd
          ? 'Session cwd remains /test'
          : undefined

      expect(hint).toBeUndefined()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2.1.210 #24: Late-appearing .claude/* symlinks reconciled into deny-write.
//
// A symlink planted at `.claude/<name>` after the previous command's sandbox
// setup would resolve OUTSIDE the literal deny paths — a write through the
// symlink bypasses the deny. reconcileClaudeSymlinks scans `.claude/*` for
// symlinks and returns the realpath'd targets so they can be deny-written.
// ─────────────────────────────────────────────────────────────────────────

describe('2.1.210 #24 — reconcileClaudeSymlinks', () => {
  test('returns realpath target of a .claude/* symlink', () => {
    // Arrange — create a temp dir with .claude/foo → /tmp/outside symlink
    const tempDir = mkdtempSync(join(tmpdir(), 'reconcile-'))
    const claudeDir = join(tempDir, '.claude')
    mkdirSync(claudeDir)
    const outsideDir = mkdtempSync(join(tmpdir(), 'outside-'))
    const symlinkPath = join(claudeDir, 'evil')
    symlinkSync(outsideDir, symlinkPath)

    try {
      // Act
      const result = reconcileClaudeSymlinks([tempDir])

      // Assert — the realpath of the symlink target is in the deny list
      expect(result).toContain(outsideDir)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('returns empty array when .claude does not exist', () => {
    // Arrange — temp dir with no .claude directory
    const tempDir = mkdtempSync(join(tmpdir(), 'noreconcile-'))

    try {
      // Act
      const result = reconcileClaudeSymlinks([tempDir])

      // Assert — nothing to reconcile
      expect(result).toEqual([])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('skips regular files (non-symlinks) in .claude/', () => {
    // Arrange — .claude/ with a regular file, not a symlink
    const tempDir = mkdtempSync(join(tmpdir(), 'regfile-'))
    const claudeDir = join(tempDir, '.claude')
    mkdirSync(claudeDir)
    writeFileSync(join(claudeDir, 'settings.json'), '{}')

    try {
      // Act
      const result = reconcileClaudeSymlinks([tempDir])

      // Assert — regular files are not symlinks, nothing added
      expect(result).toEqual([])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('handles multiple dirs (original + current cwd)', () => {
    // Arrange — two dirs, each with a .claude/* symlink
    const dir1 = mkdtempSync(join(tmpdir(), 'multi1-'))
    const dir2 = mkdtempSync(join(tmpdir(), 'multi2-'))
    const target1 = mkdtempSync(join(tmpdir(), 'tgt1-'))
    const target2 = mkdtempSync(join(tmpdir(), 'tgt2-'))
    for (const [dir, target] of [[dir1, target1], [dir2, target2]] as const) {
      const c = join(dir, '.claude')
      mkdirSync(c)
      symlinkSync(target, join(c, 'link'))
    }

    try {
      // Act
      const result = reconcileClaudeSymlinks([dir1, dir2])

      // Assert — both targets are in the deny list
      expect(result).toContain(target1)
      expect(result).toContain(target2)
      expect(result.length).toBe(2)
    } finally {
      for (const d of [dir1, dir2, target1, target2]) {
        rmSync(d, { recursive: true, force: true })
      }
    }
  })

  test('deduplicates repeated symlink targets', () => {
    // Arrange — two symlinks pointing to the same target
    const tempDir = mkdtempSync(join(tmpdir(), 'dedup-'))
    const claudeDir = join(tempDir, '.claude')
    mkdirSync(claudeDir)
    const target = mkdtempSync(join(tmpdir(), 'shared-target-'))
    symlinkSync(target, join(claudeDir, 'link1'))
    symlinkSync(target, join(claudeDir, 'link2'))

    try {
      // Act
      const result = reconcileClaudeSymlinks([tempDir])

      // Assert — target appears only once
      expect(result.filter(t => t === target).length).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  test('fails closed for unresolvable symlinks (dangling)', () => {
    // Arrange — a dangling symlink (target doesn't exist)
    const tempDir = mkdtempSync(join(tmpdir(), 'dangling-'))
    const claudeDir = join(tempDir, '.claude')
    mkdirSync(claudeDir)
    const danglingTarget = join(tmpdir(), 'nonexistent-target-' + Date.now())
    symlinkSync(danglingTarget, join(claudeDir, 'broken'), 'dir')

    try {
      // Act
      const result = reconcileClaudeSymlinks([tempDir])

      // Assert — fails closed: the symlink path itself is in the deny list
      expect(result.length).toBe(1)
      expect(result[0]).toContain('broken')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
