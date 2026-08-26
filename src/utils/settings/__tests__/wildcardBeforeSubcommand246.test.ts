import { describe, expect, test } from 'bun:test'
import { validatePermissionRule } from '../permissionValidation.js'

/**
 * 2.1.246 — "Added a startup warning for Bash allow rules with a wildcard
 * before the subcommand (e.g. `Bash(git * main)`), since they also match
 * options inserted before the subcommand".
 *
 * Ported from the official 2.1.246 rule validator (binary `rs`): the
 * detector chain (`ss`/`os`/`ln`) is byte-for-byte, the warning fires for
 * ALLOW rules only, and the message text (including the git-specific
 * addenda) is byte-matched to the binary.
 */

describe('2.1.246 — wildcard-before-subcommand startup warning', () => {
  test('allow rule Bash(git * main) warns with the git-specific addenda', () => {
    const result = validatePermissionRule('Bash(git * main)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBe(
      'Bash(git * main) has a wildcard before the rest of the command, so it also matches any options inserted at that position and approves them without a prompt. For git, options such as -c and --exec-path can run arbitrary commands. Replace that * with the exact value you mean, or only use * after the subcommand (for example Bash(git status *)).',
    )
  })

  test('allow rule Bash(npm * install) warns without the git addenda', () => {
    const result = validatePermissionRule('Bash(npm * install)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBe(
      'Bash(npm * install) has a wildcard before the rest of the command, so it also matches any options inserted at that position and approves them without a prompt. Replace that * with the exact value you mean, or only use * after the subcommand.',
    )
  })

  test('wildcard before a later subcommand word warns (Bash(git * status))', () => {
    const result = validatePermissionRule('Bash(git * status)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toContain('has a wildcard before the rest of the command')
    expect(result.warning).toContain('For git, options such as -c')
  })

  test('wildcard followed by more words warns on the first literal (Bash(git * main extra))', () => {
    const result = validatePermissionRule('Bash(git * main extra)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toContain('Bash(git * main extra) has a wildcard')
  })

  test('deny rules accept the same pattern without a warning (allow-only gate)', () => {
    const result = validatePermissionRule('Bash(git * main)', 'deny')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('ask rules accept the same pattern without a warning (allow-only gate)', () => {
    const result = validatePermissionRule('Bash(git * main)', 'ask')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('no behavior passed (schema path) does not warn', () => {
    const result = validatePermissionRule('Bash(git * main)')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('trailing wildcard is fine (Bash(git checkout *))', () => {
    const result = validatePermissionRule('Bash(git checkout *)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('legacy prefix syntax is exempt (Bash(git status:*))', () => {
    const result = validatePermissionRule('Bash(git status:*)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('two-token rules are exempt (Bash(git *))', () => {
    const result = validatePermissionRule('Bash(git *)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('wildcard followed only by options does not warn (Bash(git * --force))', () => {
    const result = validatePermissionRule('Bash(git * --force)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('wildcard first token is exempt (Bash(* install foo))', () => {
    const result = validatePermissionRule('Bash(* install foo)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('no wildcard at all does not warn (Bash(npm run build))', () => {
    const result = validatePermissionRule('Bash(npm run build)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('escaped wildcard does not warn (Bash(git \\* main))', () => {
    const result = validatePermissionRule('Bash(git \\* main)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('operator token after the wildcard aborts the scan (Bash(git * && main))', () => {
    const result = validatePermissionRule('Bash(git * && main)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('fd-redirection token is an operator (Bash(git * 2> main))', () => {
    const result = validatePermissionRule('Bash(git * 2> main)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  test('non-Bash allow rules are untouched by the new check', () => {
    // The Write(path) canonical-name warning (2.1.210) still works and is
    // not shadowed by the Bash wildcard check.
    const result = validatePermissionRule('Write(./src/app.ts)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toContain('not matched by file permission checks')
  })
})
