import { describe, expect, test } from 'bun:test'
import { prependModeCharacterToInput } from '../../components/PromptInput/inputModes.js'
import {
  resolveEffectiveInputMode,
  shouldSkipAutoPromptRestore,
} from '../submitInputMode309.js'

/**
 * CC 2.1.309 PORT (WP-D / changelog item 14) — effective input-mode resolution
 * + the mode-restore guard for key-bound slash commands.
 *
 * Official BIN309 composer onSubmit:
 *   effective mode:  `ao=D?.inputModeOverride??st.mode`      (@276385137)
 *   restore guard:   `tn=D?.inputModeOverride!==void 0&&(D.fromKeybinding===!0||D.keepsComposer===!0)`
 *                    `if(Yo&&!tn)st.setMode("prompt")`        (@276387905)
 *
 * STRUCTURAL DEVIATION: the official computes `ao`/`tn` inline in the minified
 * composer; OCC extracts them here as named pure predicates following the repo
 * convention (src/screens/promptSuppression.ts, resumeFailureGate.ts). Semantics
 * are byte-faithful. OCC's submit options carry only `fromKeybinding` +
 * `inputModeOverride` today (no `keepsComposer` producer exists), so the
 * keepsComposer clause of `tn` is dormant-but-faithful.
 */

describe('resolveEffectiveInputMode (2.1.309 item 14)', () => {
  test('falls back to the live input mode when no override is present', () => {
    // ao = D?.inputModeOverride ?? st.mode
    expect(resolveEffectiveInputMode('bash', undefined)).toBe('bash')
    expect(resolveEffectiveInputMode('prompt', undefined)).toBe('prompt')
    expect(resolveEffectiveInputMode('bash', {})).toBe('bash')
  })

  test('fromKeybinding alone does NOT override the mode', () => {
    expect(resolveEffectiveInputMode('bash', { fromKeybinding: true })).toBe(
      'bash',
    )
  })

  test('inputModeOverride:"prompt" wins over a live bash mode', () => {
    // The whole point of item 14: a key-bound slash command fired while the
    // composer is in `!` mode submits as a prompt, not the shell.
    expect(
      resolveEffectiveInputMode('bash', {
        fromKeybinding: true,
        inputModeOverride: 'prompt',
      }),
    ).toBe('prompt')
  })

  test('override applies even without fromKeybinding', () => {
    expect(
      resolveEffectiveInputMode('bash', { inputModeOverride: 'prompt' }),
    ).toBe('prompt')
  })
})

describe('shouldSkipAutoPromptRestore (2.1.309 item 14, official `tn`)', () => {
  test('no options → restore to prompt (guard false)', () => {
    expect(shouldSkipAutoPromptRestore(undefined)).toBe(false)
    expect(shouldSkipAutoPromptRestore({})).toBe(false)
  })

  test('override + fromKeybinding → SKIP restore (preserve user `!` mode)', () => {
    expect(
      shouldSkipAutoPromptRestore({
        fromKeybinding: true,
        inputModeOverride: 'prompt',
      }),
    ).toBe(true)
  })

  test('override + keepsComposer → SKIP restore (faithful tn clause)', () => {
    expect(
      shouldSkipAutoPromptRestore({
        keepsComposer: true,
        inputModeOverride: 'prompt',
      }),
    ).toBe(true)
  })

  test('override WITHOUT fromKeybinding/keepsComposer → restore (308→309 delta)', () => {
    // 308 skipped restore whenever ANY override was present; 309 only skips
    // when the override came from a keybinding or keepsComposer.
    expect(
      shouldSkipAutoPromptRestore({ inputModeOverride: 'prompt' }),
    ).toBe(false)
  })

  test('fromKeybinding WITHOUT an override → restore (tn needs the override)', () => {
    expect(shouldSkipAutoPromptRestore({ fromKeybinding: true })).toBe(false)
  })
})

describe('history display prefix uses the EFFECTIVE mode (2.1.309 item 14)', () => {
  test('live bash mode prefixes "!" (regression: SPe(h,ao) with ao=st.mode)', () => {
    const effective = resolveEffectiveInputMode('bash', undefined)
    expect(prependModeCharacterToInput('ls -la', effective)).toBe('!ls -la')
  })

  test('keybinding override from bash mode drops the "!" prefix (ao="prompt")', () => {
    // Official `{display:SPe(h,ao)}` (@276385717): the history entry shows the
    // command as submitted — a keybound /commit from `!` mode is a PROMPT
    // submit, so no bash prefix may leak into the history display.
    const effective = resolveEffectiveInputMode('bash', {
      fromKeybinding: true,
      inputModeOverride: 'prompt',
    })
    expect(prependModeCharacterToInput('/commit', effective)).toBe('/commit')
    // Contrast: with the live mode (pre-309 behavior) the same submit would
    // have been displayed as "!/commit".
    expect(prependModeCharacterToInput('/commit', 'bash')).toBe('!/commit')
  })
})
