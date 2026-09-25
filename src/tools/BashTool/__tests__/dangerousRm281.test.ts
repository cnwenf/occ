// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this suite tests literal bash `${VAR}`/`${VAR:-default}` shell syntax in command strings and expected messages, not JS template placeholders.
import { afterEach, describe, expect, test } from 'bun:test'
import { findCatastrophicSubstitutionBlock } from '../destructiveCommandWarning.js'

// ─────────────────────────────────────────────────────────────────────────
// 2.1.281 #034 + #110 (🔒 security): dangerous-rm static analyzer upgrades.
//
// Before this port `rm -rf "$(pwd)"` ran UNPROMPTED in auto mode and under
// --dangerously-skip-permissions. These tests pin the five new arms
// (wholeSubstitution, emptyExpansion, backslash-only, var+top-level,
// tracked/cwd-derived vars), the kill-switch env var, benign negatives, and
// the v280-era regression categories. Message strings are byte-exact ports
// of the official 2.1.281 binary (see destructiveCommandWarning.ts section
// header for ELF offsets).
// ─────────────────────────────────────────────────────────────────────────

const KILL_SWITCH_ENV = 'CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT'

const WHOLE_SUB_REASON =
  'Dangerous rm operation detected: the target is the output of a command substitution (`$(...)` or backticks) and cannot be checked before the command runs. This requires explicit approval and cannot be auto-allowed by permission rules.\n\nRun the substitution on its own first, then remove the literal paths it prints.'
const WHOLE_SUB_DECISION_REASON =
  'Dangerous rm operation on statically-unresolvable target: command substitution output'

afterEach(() => {
  delete process.env[KILL_SWITCH_ENV]
})

describe('2.1.281 #034 wholeSubstitution arm', () => {
  test('rm -rf "$(pwd)" now blocks with the v281 message (was unprompted)', () => {
    const block = findCatastrophicSubstitutionBlock('rm -rf "$(pwd)"')
    expect(block).not.toBeNull()
    expect(block?.category).toBe('rm_substitution_whole_target')
    expect(block?.reason).toBe(WHOLE_SUB_REASON)
    expect(block?.decisionReason).toBe(WHOLE_SUB_DECISION_REASON)
  })

  test('unquoted substitution with short recursive flag blocks', () => {
    const block = findCatastrophicSubstitutionBlock('rm -r $(echo /tmp/x)')
    expect(block?.category).toBe('rm_substitution_whole_target')
    expect(block?.reason).toBe(WHOLE_SUB_REASON)
  })

  test('backtick substitution blocks', () => {
    const block = findCatastrophicSubstitutionBlock('rm -rf `pwd`')
    expect(block?.category).toBe('rm_substitution_whole_target')
  })

  test('substitution with trailing slash/glob still blocks', () => {
    expect(
      findCatastrophicSubstitutionBlock('rm -rf $(pwd)/')?.category,
    ).toBe('rm_substitution_whole_target')
    expect(
      findCatastrophicSubstitutionBlock('rm -rf $(pwd)/*')?.category,
    ).toBe('rm_substitution_whole_target')
  })

  test('${VAR:-$(…)} default expansion folds into the arm', () => {
    expect(
      findCatastrophicSubstitutionBlock('rm -rf ${X:-$(pwd)}')?.category,
    ).toBe('rm_substitution_whole_target')
    expect(
      findCatastrophicSubstitutionBlock('rm -rf "${X:-$(pwd)}"')?.category,
    ).toBe('rm_substitution_whole_target')
  })

  test('compound command with whole-substitution rm blocks', () => {
    const block = findCatastrophicSubstitutionBlock(
      'echo hi && rm -rf "$(pwd)"',
    )
    expect(block?.category).toBe('rm_substitution_whole_target')
  })

  test('non-recursive rm of a substitution does not block', () => {
    expect(findCatastrophicSubstitutionBlock('rm -f "$(pwd)"')).toBeNull()
  })

  test('substitution followed by literal path segments does not block (binary parity)', () => {
    expect(findCatastrophicSubstitutionBlock('rm -rf $(pwd)/build')).toBeNull()
  })

  test('kill-switch env var disables only the wholeSubstitution arm', () => {
    process.env[KILL_SWITCH_ENV] = '1'
    expect(findCatastrophicSubstitutionBlock('rm -rf "$(pwd)"')).toBeNull()
    // Other v281 arms are not gated by the kill switch (binary parity).
    expect(
      findCatastrophicSubstitutionBlock('rm -rf "$TMPDIR"')?.category,
    ).toBe('rm_possibly_empty_var_path')
    expect(findCatastrophicSubstitutionBlock('rm -rf \\\\')?.category).toBe(
      'rm_backslash_only_drive_root',
    )
    delete process.env[KILL_SWITCH_ENV]
    expect(
      findCatastrophicSubstitutionBlock('rm -rf "$(pwd)"')?.category,
    ).toBe('rm_substitution_whole_target')
  })

  test('empty kill-switch value keeps the prompt (binary truthiness parity)', () => {
    process.env[KILL_SWITCH_ENV] = ''
    expect(
      findCatastrophicSubstitutionBlock('rm -rf "$(pwd)"')?.category,
    ).toBe('rm_substitution_whole_target')
  })
})

describe('2.1.281 #034 emptyExpansion arm', () => {
  test('literal root prefix + substitution blocks as critical path', () => {
    const block = findCatastrophicSubstitutionBlock('rm -rf /$(pwd)')
    expect(block?.category).toBe('rm_substitution_empty_expansion')
    expect(block?.reason).toBe(
      "Dangerous rm operation detected: '/'\n\nThis command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.",
    )
    expect(block?.decisionReason).toBe(
      'Dangerous rm operation on critical path: /',
    )
  })

  test('literal home prefix + substitution blocks as critical path', () => {
    const block = findCatastrophicSubstitutionBlock('rm -rf ~$(pwd)')
    expect(block?.category).toBe('rm_substitution_empty_expansion')
    expect(block?.decisionReason).toBe(
      'Dangerous rm operation on critical path: ~',
    )
  })

  test('non-critical literal prefix does not block', () => {
    expect(findCatastrophicSubstitutionBlock('rm -rf /tmp/$(pwd)')).toBeNull()
  })
})

describe('2.1.281 #110 backslash-only drive-root arm', () => {
  test('quoted double-backslash target warns about Git Bash drive root', () => {
    const block = findCatastrophicSubstitutionBlock('rm -rf "\\\\"')
    expect(block?.category).toBe('rm_backslash_only_drive_root')
    expect(block?.reason).toContain(
      'A backslash-only target is the drive root in Git Bash on Windows.',
    )
    // The splitter unescapes `\\` → `\` (shell semantics), so the message
    // shows a single backslash — the same argv view the official binary sees.
    expect(block?.decisionReason).toBe(
      'Dangerous rm operation on drive root: \\',
    )
  })

  test('single backslash target blocks', () => {
    expect(findCatastrophicSubstitutionBlock('rm -rf \\')?.category).toBe(
      'rm_backslash_only_drive_root',
    )
  })

  test('rmdir backslash-only target blocks with rmdir wording', () => {
    const block = findCatastrophicSubstitutionBlock('rmdir \\')
    expect(block?.category).toBe('rm_backslash_only_drive_root')
    expect(block?.reason).toContain('Dangerous rmdir operation detected')
  })
})

describe('2.1.281 #110 var+top-level (placeholder_root_child) arm', () => {
  test('quoted tracked var + top-level dir blocks with the top-level message', () => {
    const block = findCatastrophicSubstitutionBlock('rm -rf "$HOME/tmp"')
    expect(block?.category).toBe('rm_placeholder_root_child')
    expect(block?.reason).toContain(
      'ends in a top-level directory name: if the expansion is empty, this removes \'/tmp\'',
    )
    expect(block?.reason).toContain('Use a literal absolute path instead.')
    expect(block?.decisionReason).toBe(
      'Dangerous rm operation on possibly-empty variable path: ${…}/tmp (use a literal path: when the expansion is empty this removes /tmp)',
    )
  })

  test('unquoted tracked var + top-level dir blocks', () => {
    expect(findCatastrophicSubstitutionBlock('rm -rf $PWD/usr')?.category).toBe(
      'rm_placeholder_root_child',
    )
  })

  test('tracked var + non-top-level dir does not block', () => {
    expect(
      findCatastrophicSubstitutionBlock('rm -rf "$HOME/projects"'),
    ).toBeNull()
  })
})

describe('2.1.281 #110 tracked/cwd-derived variable arm (avo → Voe)', () => {
  test('rm -rf "$TMPDIR" blocks as possibly-empty variable path', () => {
    const block = findCatastrophicSubstitutionBlock('rm -rf "$TMPDIR"')
    expect(block?.category).toBe('rm_possibly_empty_var_path')
    expect(block?.reason).toContain(
      'The target \'$TMPDIR\' is a shell variable expansion: when $TMPDIR is unset or empty it becomes `/`, `/*` or a top-level path.',
    )
    expect(block?.reason).toContain('rewrite it as `"${TMPDIR:?}"`')
    expect(block?.decisionReason).toBe(
      'Dangerous rm operation on possibly-empty variable path: $TMPDIR in `rm -rf "$TMPDIR"` (rewrite it as "${TMPDIR:?}" or use a literal path)',
    )
  })

  test('unquoted $OLDPWD blocks', () => {
    expect(findCatastrophicSubstitutionBlock('rm -rf $OLDPWD')?.category).toBe(
      'rm_possibly_empty_var_path',
    )
  })

  test('braced ${TMPDIR} blocks', () => {
    expect(findCatastrophicSubstitutionBlock('rm -rf ${TMPDIR}')?.category).toBe(
      'rm_possibly_empty_var_path',
    )
  })

  test('"$HOME/" upgrades from the legacy var-path message to the v281 message', () => {
    const block = findCatastrophicSubstitutionBlock('rm -rf "$HOME/"')
    expect(block?.category).toBe('rm_possibly_empty_var_path')
    expect(block?.reason).toContain('$HOME')
    expect(block?.reason).toContain('is a shell variable expansion')
  })

  test('$TMPDIR/* blocks via the tracked-var upgrade of the var-path arm', () => {
    expect(findCatastrophicSubstitutionBlock('rm -rf $TMPDIR/*')?.category).toBe(
      'rm_possibly_empty_var_path',
    )
  })

  test('non-tracked variable does not block', () => {
    expect(findCatastrophicSubstitutionBlock('rm -rf "$BUILD_DIR"')).toBeNull()
  })

  test('tracked var with a literal subpath does not block', () => {
    expect(
      findCatastrophicSubstitutionBlock('rm -rf "$TMPDIR/logs"'),
    ).toBeNull()
  })
})

describe('benign commands stay unprompted', () => {
  test('plain file removal does not block', () => {
    expect(findCatastrophicSubstitutionBlock('rm file.txt')).toBeNull()
  })

  test('explicit scoped recursive removal does not block', () => {
    expect(
      findCatastrophicSubstitutionBlock('rm -rf /tmp/explicit/path'),
    ).toBeNull()
  })

  test('compound with scoped removal does not block', () => {
    expect(
      findCatastrophicSubstitutionBlock('ls -la && rm -rf ./build'),
    ).toBeNull()
  })
})

describe('v280-era regressions preserved', () => {
  test('literal ~ inside substitution keeps root_home category', () => {
    const block = findCatastrophicSubstitutionBlock('echo $(rm -rf ~)')
    expect(block?.category).toBe('rm_substitution_root_home')
  })

  test('bare $HOME inside substitution keeps root_home category', () => {
    const block = findCatastrophicSubstitutionBlock('echo $(rm -rf $HOME)')
    expect(block?.category).toBe('rm_substitution_root_home')
  })

  test('non-tracked $UNSET/* keeps the legacy var_path message', () => {
    const block = findCatastrophicSubstitutionBlock('echo $(rm -rf $UNSET/*)')
    expect(block?.category).toBe('rm_substitution_var_path')
    expect(block?.reason).toBe(
      "Dangerous rm operation detected inside command substitution: '$UNSET/*'",
    )
    expect(block?.decisionReason).toBeUndefined()
  })

  test('subshell rm of literal root still blocks', () => {
    expect(
      findCatastrophicSubstitutionBlock('echo hi && (rm -rf /)')?.category,
    ).toBe('rm_substitution_root_home')
  })

  test('quoted rm text inside a string is not a false positive', () => {
    expect(
      findCatastrophicSubstitutionBlock('echo "a && rm -rf /"'),
    ).toBeNull()
  })
})
