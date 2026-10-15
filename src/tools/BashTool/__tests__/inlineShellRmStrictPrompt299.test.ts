// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the official A4o message contains a literal bash `${NAME:?}` guard idiom, not a JS template placeholder.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  ansiCEscapeDetected,
  findDangerousInlineShellRm,
  INLINE_SHELL_RM_KILL_SWITCH_ENV_VAR,
  INLINE_SHELL_RM_STRICT_PROMPT_ENV_VAR,
  INLINE_SHELL_UNCHECKED_REASON,
  inlineShellRmContentDetected,
  inlineShellRmStrictPromptActive,
  shouldPromptForUncheckedInlineShellRm,
} from '../inlineShellRm.js'

// The permission path reaches getBundledSkillsRoot, which reads
// MACRO.VERSION (build-time constant polyfilled in cli.tsx at runtime).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.299 (#030): relax rm prompts default — official `vpo`/`Ele`/`wpo`/
 * `KMt` (byte-exact @224224084 region in /tmp/cc-diff-299/v299/package/
 * claude):
 *   `function vpo(){return!a.CLAUDE_CODE_STRICT_INLINE_SHELL_RM_PROMPT&&k("tengu_pale_kestrel",!0)}`
 *   `function Ele(...e){return!vpo()||e.some((n)=>wpo(n)||KMt(n))}`
 * Unchecked asks (depth cap / unreadable constructs / ANSI-C-quoted rm) only
 * fire when strict mode is on OR some text carries real rm evidence (`wpo`
 * deep detector or `KMt` ANSI-C escape). Confirmed-dangerous verdicts and
 * the hex-escape arm (`||KMt(tt)` outside the gate) stay unconditional.
 */

const savedStrict = process.env[INLINE_SHELL_RM_STRICT_PROMPT_ENV_VAR]
const savedKill = process.env[INLINE_SHELL_RM_KILL_SWITCH_ENV_VAR]

afterEach(() => {
  for (const [key, value] of [
    [INLINE_SHELL_RM_STRICT_PROMPT_ENV_VAR, savedStrict],
    [INLINE_SHELL_RM_KILL_SWITCH_ENV_VAR, savedKill],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function setStrict(value: string | undefined): void {
  if (value === undefined) delete process.env[INLINE_SHELL_RM_STRICT_PROMPT_ENV_VAR]
  else process.env[INLINE_SHELL_RM_STRICT_PROMPT_ENV_VAR] = value
}

// ── Gate function (official `vpo` strict half; RAW truthiness) ──────────

describe('inlineShellRmStrictPromptActive (CC 2.1.299 #030 env gate)', () => {
  test('unset → false (relaxation active, statsig treated default-on)', () => {
    setStrict(undefined)
    expect(inlineShellRmStrictPromptActive()).toBe(false)
  })

  test('RAW truthiness: "1" and "0" both → true (matches official `!a.X` string check)', () => {
    setStrict('1')
    expect(inlineShellRmStrictPromptActive()).toBe(true)
    setStrict('0')
    expect(inlineShellRmStrictPromptActive()).toBe(true)
  })
})

// ── `wpo` port: deep rm-content detector ─────────────────────────────────

describe('inlineShellRmContentDetected (official wpo)', () => {
  test('plain rm invocation → true', () => {
    expect(inlineShellRmContentDetected('rm -rf /tmp/build')).toBe(true)
    expect(inlineShellRmContentDetected('echo hi; rmdir out')).toBe(true)
    expect(inlineShellRmContentDetected('/bin/rm.exe -rf x')).toBe(true)
  })

  test('rm not standalone (--rm flag, .rm suffix, confirm word) → false', () => {
    expect(inlineShellRmContentDetected('docker run --rm image')).toBe(false)
    expect(inlineShellRmContentDetected('echo .rm; echo confirm')).toBe(false)
  })

  test('line continuation joining exposes hidden rm → true', () => {
    expect(inlineShellRmContentDetected('echo r\\\nm -rf /')).toBe(true)
  })

  test('${VAR:-rm} default arm → true', () => {
    expect(inlineShellRmContentDetected('${CMD:-rm} -rf "$X"')).toBe(true)
  })

  test('brace expansion producing rm (official ABe arm) → true', () => {
    expect(inlineShellRmContentDetected('{rm,x} -rf /')).toBe(true)
    expect(inlineShellRmContentDetected('foo/{../rm} -rf /')).toBe(true)
    expect(inlineShellRmContentDetected('{echo,ls} hi')).toBe(false)
  })

  test('quoted rm still counts (quote-strip normalization) → true', () => {
    expect(inlineShellRmContentDetected('"rm" -rf /')).toBe(true)
    expect(inlineShellRmContentDetected(String.raw`echo '\x72m'`)).toBe(false)
  })
})

// ── `KMt` port: ANSI-C escape detector ───────────────────────────────────

describe('ansiCEscapeDetected (official KMt)', () => {
  test('$\'…\\x…\' hex escape → true', () => {
    expect(ansiCEscapeDetected(String.raw`$'\x72m -rf /'`)).toBe(true)
    expect(ansiCEscapeDetected(String.raw`echo hi; printf $'\162m'`)).toBe(true)
  })

  test('plain ANSI-C quote without \\x\\u\\U\\c\\0-7 escape → false', () => {
    expect(ansiCEscapeDetected("$'plain text'")).toBe(false)
    expect(ansiCEscapeDetected('rm -rf /tmp/x')).toBe(false)
  })

  test('escape split by line continuation → true (joined variant)', () => {
    // `$'\x7\<NL>2m'` — the joined variant `$'\x72m'` matches RMt.
    const splitEscape = ["$'\\x7\\", '\n', "2m'"].join('')
    expect(ansiCEscapeDetected(splitEscape)).toBe(true)
  })
})

// ── `Ele` port: relaxed-mode gate ────────────────────────────────────────

describe('shouldPromptForUncheckedInlineShellRm (official Ele)', () => {
  test('strict env set → always true regardless of content', () => {
    setStrict('1')
    expect(shouldPromptForUncheckedInlineShellRm('docker run --rm x')).toBe(true)
    expect(shouldPromptForUncheckedInlineShellRm('')).toBe(true)
  })

  test('relaxed → true only with wpo/KMt evidence', () => {
    setStrict(undefined)
    expect(shouldPromptForUncheckedInlineShellRm('echo --rm')).toBe(false)
    expect(shouldPromptForUncheckedInlineShellRm('echo --rm', 'rm -rf /')).toBe(
      true,
    )
    expect(
      shouldPromptForUncheckedInlineShellRm(String.raw`$'\x72m -rf /'`),
    ).toBe(true)
  })
})

// ── End-to-end through findDangerousInlineShellRm ────────────────────────

describe('findDangerousInlineShellRm relaxed default (CC 2.1.299 #030)', () => {
  test('unreadable script whose only "rm" is a --rm flag → NO block relaxed, block strict', () => {
    const command = `bash -c 'printf -v msg --rm; echo $msg'`
    setStrict(undefined)
    expect(findDangerousInlineShellRm(command)).toBeNull()
    setStrict('1')
    const strictBlock = findDangerousInlineShellRm(command)
    expect(strictBlock?.reason).toBe(INLINE_SHELL_UNCHECKED_REASON)
  })

  test('unreadable (eval) script WITH real rm evidence → blocks in both modes', () => {
    const command = `bash -c 'eval "$X"; rm -rf "$Y"'`
    setStrict(undefined)
    expect(findDangerousInlineShellRm(command)?.reason).toBe(
      INLINE_SHELL_UNCHECKED_REASON,
    )
    setStrict('1')
    expect(findDangerousInlineShellRm(command)?.reason).toBe(
      INLINE_SHELL_UNCHECKED_REASON,
    )
  })

  test('script with no rm word at all → no block in either mode', () => {
    for (const strict of [undefined, '1']) {
      setStrict(strict)
      expect(findDangerousInlineShellRm(`bash -c 'eval "$X"'`)).toBeNull()
    }
  })

  test('readable confirmed-dangerous rm → unchanged (blocks in both modes)', () => {
    for (const strict of [undefined, '1']) {
      setStrict(strict)
      expect(findDangerousInlineShellRm(`bash -c 'rm -rf /'`)).not.toBeNull()
    }
  })

  test('ANSI-C hex escape → unconditional unchecked block (official KMt outside gate)', () => {
    const command = String.raw`bash -c $'\x72m -rf /'`
    for (const strict of [undefined, '1']) {
      setStrict(strict)
      const block = findDangerousInlineShellRm(command)
      expect(block?.reason).toBe(INLINE_SHELL_UNCHECKED_REASON)
    }
  })

  test('kill switch still wins over both modes', () => {
    process.env[INLINE_SHELL_RM_KILL_SWITCH_ENV_VAR] = '1'
    setStrict('1')
    expect(findDangerousInlineShellRm(`bash -c 'rm -rf /'`)).toBeNull()
    setStrict(undefined)
    expect(findDangerousInlineShellRm(`bash -c 'eval "$X"; rm -rf "$Y"'`)).toBeNull()
  })
})
