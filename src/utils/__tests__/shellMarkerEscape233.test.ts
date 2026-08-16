import { describe, expect, test } from 'bun:test'
import {
  escapeAngleBrackets,
  escapeShellExecutionMarkers,
  sanitizeUsername,
} from '../promptShellExecution'
import { substituteArguments } from '../argumentSubstitution'
import { substituteUserConfigInContent } from '../plugins/pluginOptionsStorage'

/**
 * claude-code 2.1.233: Q9/Z7t/EYp shell-marker escape family (Gap-96 port).
 *
 * The official 2.1.233 binary passes its `Q9` escape as the sCt 5th-param
 * value transform wherever slash-command arguments are substituted into a
 * prompt that later runs executeShellCommandsInPrompt — so an argument like
 * !`id` can never form a LIVE shell-execution marker. MCP-loaded content is
 * additionally angle-bracket escaped (Z7t(Q9)), and the /commit-push-pr
 * builtin embeds usernames through EYp and attribution/args through Q9.
 *
 * All expectations below were verified byte-for-byte against the official
 * linux-x64 2.1.233 binary (30/30 empirical probes) BEFORE porting — per the
 * aligning-with-official-binary discipline. Note Q9's three replaces run
 * SEQUENTIALLY (each step sees the previous one's output).
 */

describe('escapeShellExecutionMarkers (official Q9)', () => {
  test('breaks inline `!`cmd`` marker: leading bang', () => {
    // !`id` -> (step2) ! `id` -> (step3) \! `id`
    expect(escapeShellExecutionMarkers('!`id`')).toBe('\\! `id`')
  })

  test('breaks backtick-bang form via the sequential chain', () => {
    // a`!b -> (step1) a` !b -> (step3, space before !) a` \!b
    // NOT a` !b — the space step1 inserts makes step3 match.
    expect(escapeShellExecutionMarkers('a`!b')).toBe('a` \\!b')
  })

  test('breaks bang-backtick form', () => {
    // x!`y -> (step2) x! `y — no whitespace before !, so step3 leaves it
    expect(escapeShellExecutionMarkers('x!`y')).toBe('x! `y')
  })

  test('escapes standalone bang at start of string and after whitespace', () => {
    expect(escapeShellExecutionMarkers('! ls')).toBe('\\! ls')
    expect(escapeShellExecutionMarkers('run ! ls')).toBe('run \\! ls')
    expect(escapeShellExecutionMarkers('a\n! ls')).toBe('a\n\\! ls')
  })

  test('leaves glued bangs alone (no live-marker shape)', () => {
    expect(escapeShellExecutionMarkers('a!b')).toBe('a!b')
    expect(escapeShellExecutionMarkers('hello!')).toBe('hello!')
    // $! is a shell variable, not a marker (same reasoning as INLINE_PATTERN)
    expect(escapeShellExecutionMarkers('echo $!')).toBe('echo $!')
  })

  test('neutralizes block-marker prefix ```!', () => {
    // ```! -> (step1) ``` ! -> step3: space before ! -> ``` \!
    expect(escapeShellExecutionMarkers('```!\nid\n```')).toBe(
      '``` \\!\nid\n```',
    )
  })

  test('neutralizes a battery of adversarial injection forms (byte-verified)', () => {
    // Each expectation computed from the official sequential Q9 chain and
    // verified against the 2.1.233 binary probes.
    const cases: Array<[string, string]> = [
      ['!`touch /tmp/pwned`', '\\! `touch /tmp/pwned`'],
      [' !`id`', ' \\! `id`'],
      ['\n!`id`', '\n\\! `id`'],
      ['x `!y', 'x ` \\!y'],
      ['```!\necho pwned\n```', '``` \\!\necho pwned\n```'],
      ['! ls -la', '\\! ls -la'],
    ]
    for (const [input, expected] of cases) {
      expect(escapeShellExecutionMarkers(input)).toBe(expected)
    }
  })

  test('empty string and plain text pass through', () => {
    expect(escapeShellExecutionMarkers('')).toBe('')
    expect(escapeShellExecutionMarkers('just some prose')).toBe(
      'just some prose',
    )
  })
})

describe('escapeAngleBrackets (official Z7t)', () => {
  test('escapes < and > but NOT &', () => {
    expect(escapeAngleBrackets('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
    expect(escapeAngleBrackets('a & b')).toBe('a & b')
    expect(escapeAngleBrackets('a < b > c')).toBe('a &lt; b &gt; c')
  })
})

describe('sanitizeUsername (official EYp)', () => {
  test('strips everything outside [a-zA-Z0-9._-]', () => {
    expect(sanitizeUsername('alice')).toBe('alice')
    expect(sanitizeUsername('alice@example.com')).toBe('aliceexample.com')
    expect(sanitizeUsername('bad user!`x`')).toBe('baduserx')
    expect(sanitizeUsername('ok.name_ok-1')).toBe('ok.name_ok-1')
    expect(sanitizeUsername('')).toBe('')
  })
})

describe('substituteArguments 5th-param valueTransform (official sCt param o)', () => {
  test('applies transform to $ARGUMENTS value', () => {
    expect(
      substituteArguments('cmd: $ARGUMENTS', 'hello', false, [], v =>
        v.toUpperCase(),
      ),
    ).toBe('cmd: HELLO')
  })

  test('applies transform to indexed and named values', () => {
    expect(
      substituteArguments('a=$0 b=$1', 'x y', false, [], v => `<${v}>`),
    ).toBe('a=<x> b=<y>')
    expect(
      substituteArguments('n=$foo', 'val', false, ['foo'], v => `[${v}]`),
    ).toBe('n=[val]')
  })

  test('applies transform on the append path too', () => {
    expect(
      substituteArguments('no placeholder', 'injected !`id`', true, [], v =>
        escapeShellExecutionMarkers(v),
      ),
    ).toBe('no placeholder\nARGUMENTS: injected \\! `id`')
  })

  test('transform runs AFTER sentinel sanitization (sees no sentinel chars)', () => {
    let sawSentinel = false
    const spy = (v: string): string => {
      if (v.includes('\uFFFF') || v.includes('\uFFFE')) {
        sawSentinel = true
      }
      return v
    }
    substituteArguments('x: $ARGUMENTS', 'val\uFFFFue\uFFFE', false, [], spy)
    expect(sawSentinel).toBe(false)
  })

  test('transform output is $-shielded: injected $ARGUMENTS is NOT re-expanded', () => {
    const result = substituteArguments(
      'x: $0',
      'a',
      false,
      [],
      () => '$ARGUMENTS',
    )
    expect(result).toBe('x: $ARGUMENTS')
  })

  test('real Q9 transform neutralizes argument injection end-to-end', () => {
    const result = substituteArguments(
      'do this: $ARGUMENTS',
      '!`id`',
      true,
      [],
      escapeShellExecutionMarkers,
    )
    expect(result).toBe('do this: \\! `id`')
  })

  test('template-owned markers stay live (transform touches values only)', () => {
    const result = substituteArguments(
      'status: !`git status` args: $ARGUMENTS',
      'plain',
      true,
      [],
      escapeShellExecutionMarkers,
    )
    expect(result).toContain('!`git status`')
    expect(result).toContain('args: plain')
  })

  test('undefined transform preserves pre-233 insertion behavior', () => {
    expect(substituteArguments('v: $ARGUMENTS', 'raw !`x`', false)).toBe(
      'v: raw !`x`',
    )
  })

  test('MCP double-escape composition (Z7t(Q9)) matches official untrusted path', () => {
    const mcpTransform = (v: string): string =>
      escapeAngleBrackets(escapeShellExecutionMarkers(v))
    // Byte-official result: the bang is glued to `>` (no whitespace before
    // it), so Q9 step 3 leaves it unescaped — and the marker is dead anyway
    // because INLINE_PATTERN requires whitespace/SOL before `!`.
    expect(
      substituteArguments('body: $ARGUMENTS', '<b>!`id`</b>', true, [], mcpTransform),
    ).toBe('body: &lt;b&gt;! `id`&lt;/b&gt;')
    // With whitespace before the bang, Q9 does escape it:
    expect(
      substituteArguments('body: $ARGUMENTS', '<b> !`id`</b>', true, [], mcpTransform),
    ).toBe('body: &lt;b&gt; \\! `id`&lt;/b&gt;')
  })
})

describe('substituteUserConfigInContent valueTransform (official X9o 4th param)', () => {
  const schema = {
    token: { description: 't', sensitive: true },
    greeting: { description: 'g' },
  } as unknown as Parameters<typeof substituteUserConfigInContent>[2]

  test('applies transform to substituted option values', () => {
    expect(
      substituteUserConfigInContent(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${user_config.KEY} syntax under test, not a JS template placeholder.
        'say ${user_config.greeting}',
        { greeting: '!`id`' },
        schema,
        escapeShellExecutionMarkers,
      ),
    ).toBe('say \\! `id`')
  })

  test('without transform, values pass through unchanged (plugin-agent path)', () => {
    expect(
      substituteUserConfigInContent(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${user_config.KEY} syntax under test, not a JS template placeholder.
        'say ${user_config.greeting}',
        { greeting: '!`id`' },
        schema,
      ),
    ).toBe('say !`id`')
  })

  test('sensitive keys still substitute to the placeholder, transform notwithstanding', () => {
    expect(
      substituteUserConfigInContent(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${user_config.KEY} syntax under test, not a JS template placeholder.
        'k=${user_config.token}',
        { token: 'sekrit' },
        schema,
        escapeShellExecutionMarkers,
      ),
    ).toBe("k=[sensitive option 'token' not available in skill content]")
  })

  test('unknown keys stay literal', () => {
    expect(
      substituteUserConfigInContent(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${user_config.KEY} syntax under test, not a JS template placeholder.
        'k=${user_config.nope}',
        {},
        schema,
        escapeShellExecutionMarkers,
      ),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${user_config.KEY} syntax under test, not a JS template placeholder.
    ).toBe('k=${user_config.nope}')
  })
})
