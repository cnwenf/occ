import { describe, expect, test } from 'bun:test'

import {
  MIN_TITLE_INPUT_LENGTH,
  TITLE_DESCRIPTION_MAX,
  UNUSABLE_REPLIES_LEFT,
  USAGE_AVAILABLE_CONTINUATION_TEXT,
  USAGE_LIMIT_RESET_CONTINUATION_TEXT,
  contentToText,
  extractTagContent,
  firstTitleEligibleMessage,
  isMeaningfulTitleText,
  isSensitiveTitleInput,
  isUsageLimitContinuationText,
  makeTitleFallback,
  parseSlashCommand,
  reduceTitleFallback,
  startsAsKnownCommand,
  titleInputFromDispatchedMessage,
  titleInputFromMessage,
  titleInputFromQueuedMessage,
  type TitleCommand,
  type TitleFallback,
} from '../sessionTitleInput.js'

/**
 * CC 2.1.314 items 61 + 78 — the official session-title input module is NEW
 * in v314 (entire module appears in the v312→v314 added-strings diff).
 * All formulas below were byte-verified in the v314 linux-x64 binary
 * (offsets noted). Shorthand for the official minified names:
 *
 *  - `var T=1000,S=10,y=200` + `var b=2` @261917800..261919165:
 *    conversation-text cap (T=1000, pre-existing), MIN_TITLE_INPUT_LENGTH
 *    (S=10 via `function _(e){return e.trim().length>=S}`),
 *    TITLE_DESCRIPTION_MAX (y=200), UNUSABLE_REPLIES_LEFT (b=2).
 *  - `zMr({content,origin,commands,dispatchesSlashCommands})` @261918331 —
 *    item 78: derive title input from a `<command-message>` breadcrumb
 *    (name from `<command-name>` via ci, args from `<command-args>`) or from
 *    raw `/name args` input that parses as a known command (l7n+Bbe→yX).
 *    Gates: `$l(origin)` (origin?.kind==="human" @247231046), command
 *    `type==="prompt"`, `$d` (isEnabled?.()??true), `!ak` (availability not
 *    off), `userInvocable!==false`, `!Xhn` (not sensitive). Title text =
 *    `` `/${name} ${args}`.trim() `` + optional `\n` + first line of
 *    (menuDescription??description).trim() truncated to 200 via ne.
 *  - `uzn({content,origin,queueSkipSlashCommands,commands})` @261918957 —
 *    skip-slash wrapper: `l=r===!0; if(l&&(BE(e)||BE(s??"")))return null;
 *    return zMr({...dispatchesSlashCommands:!l})`.
 *  - `fzn({prose,isContinuationTurn,fallback})` @261919165 — item 61:
 *    `if(e!==null&&_(e))return{text:e,unusableRepliesLeft:b};
 *     if(r&&(e!==null||c))return r; return`
 *  - `pzn(e,c)` @261919312 — item 61:
 *    `switch(c.kind){case"titled":return;case"failed":return e;
 *     case"unusable":return e.unusableRepliesLeft>1?
 *       {text:e.text,unusableRepliesLeft:e.unusableRepliesLeft-1}:void 0}`
 *  - `KFs(e){return e.find(Bme)}` @261919731 with
 *    `Bme(e){return e.type==="user"&&!e.isMeta&&e.toolUseResult===void 0
 *      &&!e.isCompactSummary&&Lg(e.origin)}` @247238964 and
 *    `Lg(e){return e===void 0||e.kind==="human"}` @247236805.
 *  - `uBs(e){return e===L||e===E||bHr()&&e.trim()===x().trim()}` @260339345
 *    with L/E the usage-limit resume strings @260320000-region.
 *  - `em(e)` @258037519 — string→as-is; array→joined text blocks trimmed
 *    ||null; else null. `iN(e)` @251632018 — last text block.
 *    `BE(e)` @251629xxx — string trim startsWith "/" OR last array text
 *    block trim startsWith "/".
 *  - `ci(n,e)` @253061957 — nesting-safe `<tag>content</tag>` extractor
 *    (Vo = escapeRegExp @243461364).
 *  - `l7n(e,n)`/`yX(e)` @251628600 region — known-command prefix test and
 *    `/name args` split. `Js(e,n)`/`VR(e,n)`/`Bbe` @251629816-251630200 —
 *    command lookup: exact name, then VR (name/getCommandName/aliases),
 *    then prompt directoryListingName.
 *  - `Xhn(e,n,{pastedTexts:r=[]}={})` @251632xxx + `URe(e,n)` @251630317 —
 *    sensitivity: `URe` = empty args→false; isSensitive function→call(args);
 *    else isSensitive===true. zMr/uzn call sites never pass pastedTexts.
 *  - `M4(e)` @245850515 — non-prose breadcrumb tags (local-command-stdout/
 *    stderr, command-message/name, bash-input/stdout/stderr,
 *    task-notification).
 *  - `pr(t)`/`Ze(t,n)` @243464345/243463911 — first line before "\n".
 */

function promptCommand(overrides: Partial<TitleCommand> = {}): TitleCommand {
  return {
    name: 'security-review',
    type: 'prompt',
    description: 'Run a security review of the current branch',
    ...overrides,
  }
}

function userMsg(
  content: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'user',
    uuid: `u-${Math.random()}`,
    message: { role: 'user', content },
    ...extra,
  }
}

describe('2.1.314 item 78 titleInputFromMessage (official zMr)', () => {
  const commands = [promptCommand()]

  test('plain prose content is returned as-is (official `else return s`)', () => {
    expect(
      titleInputFromMessage({
        content: 'fix the login bug in auth.ts',
        origin: { kind: 'human' },
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBe('fix the login bug in auth.ts')
  })

  test('origin undefined counts as human (official Lg: undefined||kind==="human")', () => {
    expect(
      titleInputFromMessage({
        content: 'plain prose prompt here',
        origin: undefined,
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBe('plain prose prompt here')
  })

  test('raw /command args for a known prompt command → "/name args\\nfirst description line" (the item 78 fix)', () => {
    expect(
      titleInputFromMessage({
        content: '/security-review src/auth',
        origin: { kind: 'human' },
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBe('/security-review src/auth\nRun a security review of the current branch')
  })

  test('command without args → bare "/name" (official f = slash-name + space + args, trimmed)', () => {
    expect(
      titleInputFromMessage({
        content: '/security-review',
        origin: { kind: 'human' },
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBe('/security-review\nRun a security review of the current branch')
  })

  test('menuDescription wins over description (official `m.menuDescription??m.description`)', () => {
    const cmds = [promptCommand({ menuDescription: 'Short menu blurb' })]
    expect(
      titleInputFromMessage({
        content: '/security-review x',
        origin: { kind: 'human' },
        commands: cmds,
        dispatchesSlashCommands: true,
      }),
    ).toBe('/security-review x\nShort menu blurb')
  })

  test('only the FIRST line of the description is used (official pr=Ze(t,"\\n"))', () => {
    const cmds = [
      promptCommand({ description: 'line one\nline two\nline three' }),
    ]
    expect(
      titleInputFromMessage({
        content: '/security-review',
        origin: { kind: 'human' },
        commands: cmds,
        dispatchesSlashCommands: true,
      }),
    ).toBe('/security-review\nline one')
  })

  test('description line truncated to 200 chars (official y=200 via ne)', () => {
    const long = 'd'.repeat(500)
    const cmds = [promptCommand({ description: long })]
    const out = titleInputFromMessage({
      content: '/security-review',
      origin: { kind: 'human' },
      commands: cmds,
      dispatchesSlashCommands: true,
    })
    expect(out).toBe(`/security-review\n${'d'.repeat(TITLE_DESCRIPTION_MAX)}`)
  })

  test('description-only command with empty description → bare "/name args" (official `h?...:f`)', () => {
    const cmds = [promptCommand({ description: '   ' })]
    expect(
      titleInputFromMessage({
        content: '/security-review foo',
        origin: { kind: 'human' },
        commands: cmds,
        dispatchesSlashCommands: true,
      }),
    ).toBe('/security-review foo')
  })

  test('local (non-prompt) command → null (official `m?.type!=="prompt"` gate)', () => {
    const cmds: TitleCommand[] = [{ name: 'help', type: 'local-jsx' }]
    expect(
      titleInputFromMessage({
        content: '/help',
        origin: { kind: 'human' },
        commands: cmds,
        dispatchesSlashCommands: true,
      }),
    ).toBeNull()
  })

  test('unknown slash command → raw text returned (official `else if(BE(l))return Xhn...?null:s`)', () => {
    expect(
      titleInputFromMessage({
        content: '/not-a-real-command do things',
        origin: { kind: 'human' },
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBe('/not-a-real-command do things')
  })

  test('disabled command → null (official $d: isEnabled?.()??true)', () => {
    const cmds = [promptCommand({ isEnabled: () => false })]
    expect(
      titleInputFromMessage({
        content: '/security-review',
        origin: { kind: 'human' },
        commands: cmds,
        dispatchesSlashCommands: true,
      }),
    ).toBeNull()
  })

  test('userInvocable===false → null (official `m.userInvocable===!1`)', () => {
    const cmds = [promptCommand({ userInvocable: false })]
    expect(
      titleInputFromMessage({
        content: '/security-review',
        origin: { kind: 'human' },
        commands: cmds,
        dispatchesSlashCommands: true,
      }),
    ).toBeNull()
  })

  test('sensitive command → null (official Xhn(f,r) gate via URe)', () => {
    const cmds = [promptCommand({ isSensitive: true })]
    expect(
      titleInputFromMessage({
        content: '/security-review secret-args',
        origin: { kind: 'human' },
        commands: cmds,
        dispatchesSlashCommands: true,
      }),
    ).toBeNull()
  })

  test('non-human origin on a command message → null (official $l(c) gate)', () => {
    expect(
      titleInputFromMessage({
        content: '/security-review',
        origin: { kind: 'auto-continuation' },
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBeNull()
    // Prose without origin still works (Lg), but command titles need $l ===
    // kind==="human" strictly; undefined origin fails $l.
    expect(
      titleInputFromMessage({
        content: '/security-review',
        origin: undefined,
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBeNull()
  })

  test('<command-message> breadcrumb with <command-name>/<command-args> → derived title (skill expansion path)', () => {
    const breadcrumb =
      '<command-message>security-review is running…</command-message>\n' +
      '<command-name>/security-review</command-name>\n' +
      '<command-args>src/auth</command-args>\n'
    expect(
      titleInputFromMessage({
        content: breadcrumb,
        origin: { kind: 'human' },
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBe('/security-review src/auth\nRun a security review of the current branch')
  })

  test('breadcrumb command-name without leading slash is accepted (official `g.startsWith("/")?g.slice(1):g`)', () => {
    const breadcrumb =
      '<command-message>x</command-message><command-name>security-review</command-name>'
    expect(
      titleInputFromMessage({
        content: breadcrumb,
        origin: { kind: 'human' },
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBe('/security-review\nRun a security review of the current branch')
  })

  test('breadcrumb with missing/empty <command-name> → null (official `if(!g)return null`)', () => {
    expect(
      titleInputFromMessage({
        content: '<command-message>running</command-message>',
        origin: { kind: 'human' },
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBeNull()
  })

  test('breadcrumb for an unknown command → null (Js lookup fails → type!=="prompt")', () => {
    const breadcrumb =
      '<command-message>x</command-message><command-name>/mystery</command-name>'
    expect(
      titleInputFromMessage({
        content: breadcrumb,
        origin: { kind: 'human' },
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBeNull()
  })

  test('non-prose breadcrumb tags → null (official M4: local-command-stdout etc.)', () => {
    for (const text of [
      '<local-command-stdout>output</local-command-stdout>',
      '<local-command-stderr>err</local-command-stderr>',
      '<bash-input>ls</bash-input>',
      '<bash-stdout>files</bash-stdout>',
      '<bash-stderr>oops</bash-stderr>',
      '<task-notification>done</task-notification>',
    ]) {
      expect(
        titleInputFromMessage({
          content: text,
          origin: { kind: 'human' },
          commands,
          dispatchesSlashCommands: true,
        }),
      ).toBeNull()
    }
  })

  test('command-message/name tags without dispatch → null (official M4 via _C)', () => {
    expect(
      titleInputFromMessage({
        content: '<command-message>x</command-message><command-name>/security-review</command-name>',
        origin: { kind: 'human' },
        commands,
        dispatchesSlashCommands: false,
      }),
    ).toBeNull()
  })

  test('array content: text blocks joined; slash detected on LAST text block (official BE/iN)', () => {
    const content = [
      { type: 'text', text: 'attachment preamble' },
      { type: 'text', text: '/security-review deep' },
    ]
    expect(
      titleInputFromMessage({
        content,
        origin: { kind: 'human' },
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBe('/security-review deep\nRun a security review of the current branch')
  })

  test('empty/whitespace array content → null (official em → null)', () => {
    expect(
      titleInputFromMessage({
        content: [{ type: 'image', source: {} }],
        origin: { kind: 'human' },
        commands,
        dispatchesSlashCommands: true,
      }),
    ).toBeNull()
  })
})

describe('2.1.314 item 78 titleInputFromQueuedMessage (official uzn)', () => {
  const commands = [promptCommand()]

  test('queueSkipSlashCommands=true + slash content → null (official `if(l&&(BE(e)||BE(s??"")))return null`)', () => {
    expect(
      titleInputFromQueuedMessage({
        content: '/security-review',
        origin: { kind: 'human' },
        queueSkipSlashCommands: true,
        commands,
      }),
    ).toBeNull()
  })

  test('queueSkipSlashCommands=true + prose content → prose still eligible', () => {
    expect(
      titleInputFromQueuedMessage({
        content: 'just prose, no command',
        origin: { kind: 'human' },
        queueSkipSlashCommands: true,
        commands,
      }),
    ).toBe('just prose, no command')
  })

  test('queueSkipSlashCommands=false → dispatches slash commands (zMr passthrough)', () => {
    expect(
      titleInputFromQueuedMessage({
        content: '/security-review x',
        origin: { kind: 'human' },
        queueSkipSlashCommands: false,
        commands,
      }),
    ).toBe('/security-review x\nRun a security review of the current branch')
  })

  test('queueSkipSlashCommands undefined → dispatches (official l=r===!0)', () => {
    expect(
      titleInputFromQueuedMessage({
        content: '/security-review',
        origin: { kind: 'human' },
        queueSkipSlashCommands: undefined,
        commands,
      }),
    ).toBe('/security-review\nRun a security review of the current branch')
  })
})

describe('2.1.314 item 61 makeTitleFallback (official fzn)', () => {
  test('prose with >=10 trimmed chars → fresh fallback with unusableRepliesLeft=2 (official b=2)', () => {
    expect(
      makeTitleFallback({
        prose: 'a long enough prompt',
        isContinuationTurn: false,
        fallback: undefined,
      }),
    ).toEqual({ text: 'a long enough prompt', unusableRepliesLeft: UNUSABLE_REPLIES_LEFT })
    expect(UNUSABLE_REPLIES_LEFT).toBe(2)
  })

  test('prose shorter than 10 trimmed chars is not meaningful (official _: e.trim().length>=S, S=10)', () => {
    expect(MIN_TITLE_INPUT_LENGTH).toBe(10)
    expect(isMeaningfulTitleText('123456789')).toBe(false)
    expect(isMeaningfulTitleText('1234567890')).toBe(true)
    expect(isMeaningfulTitleText('  1234567890  ')).toBe(true)
    expect(
      makeTitleFallback({ prose: 'short', isContinuationTurn: false, fallback: undefined }),
    ).toBeUndefined()
  })

  test('prose null + continuation turn + existing fallback → fallback preserved (the item 61 fix)', () => {
    const existing: TitleFallback = { text: 'original failed prompt', unusableRepliesLeft: 2 }
    expect(
      makeTitleFallback({ prose: null, isContinuationTurn: true, fallback: existing }),
    ).toBe(existing)
  })

  test('prose null + NOT continuation + fallback → dropped (official `if(r&&(e!==null||c))`)', () => {
    const existing: TitleFallback = { text: 'old prompt text here', unusableRepliesLeft: 1 }
    expect(
      makeTitleFallback({ prose: null, isContinuationTurn: false, fallback: existing }),
    ).toBeUndefined()
  })

  test('too-short prose + fallback (prose!==null) → fallback preserved', () => {
    const existing: TitleFallback = { text: 'previous good prose', unusableRepliesLeft: 2 }
    expect(
      makeTitleFallback({ prose: 'tiny', isContinuationTurn: false, fallback: existing }),
    ).toBe(existing)
  })

  test('meaningful prose replaces the old fallback text', () => {
    const existing: TitleFallback = { text: 'previous good prose', unusableRepliesLeft: 1 }
    expect(
      makeTitleFallback({ prose: 'a brand new prompt', isContinuationTurn: false, fallback: existing }),
    ).toEqual({ text: 'a brand new prompt', unusableRepliesLeft: 2 })
  })
})

describe('2.1.314 item 61 reduceTitleFallback (official pzn)', () => {
  const fallback: TitleFallback = { text: 'the first prompt', unusableRepliesLeft: 2 }

  test('titled → fallback cleared (official case"titled":return)', () => {
    expect(reduceTitleFallback(fallback, { kind: 'titled', title: 'Fix login' })).toBeUndefined()
  })

  test('failed → fallback preserved UNCHANGED (official case"failed":return e) — retry titles the original prompt', () => {
    expect(reduceTitleFallback(fallback, { kind: 'failed' })).toBe(fallback)
  })

  test('unusable → decrements unusableRepliesLeft while >1', () => {
    expect(reduceTitleFallback(fallback, { kind: 'unusable' })).toEqual({
      text: 'the first prompt',
      unusableRepliesLeft: 1,
    })
  })

  test('unusable at 1 → fallback dropped (official ternary → void 0)', () => {
    expect(
      reduceTitleFallback({ text: 'the first prompt', unusableRepliesLeft: 1 }, { kind: 'unusable' }),
    ).toBeUndefined()
  })
})

describe('2.1.314 item 61 isUsageLimitContinuationText (official uBs)', () => {
  test('matches the usage-limit reset resume string (official L)', () => {
    expect(isUsageLimitContinuationText(USAGE_LIMIT_RESET_CONTINUATION_TEXT)).toBe(true)
    expect(USAGE_LIMIT_RESET_CONTINUATION_TEXT).toBe(
      'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.',
    )
  })

  test('matches the usage-available-again resume string (official E)', () => {
    expect(isUsageLimitContinuationText(USAGE_AVAILABLE_CONTINUATION_TEXT)).toBe(true)
    expect(USAGE_AVAILABLE_CONTINUATION_TEXT).toBe(
      'Your claude.ai usage is available again before the usage-limit reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.',
    )
  })

  test('other text → false (exact equality, not substring)', () => {
    expect(isUsageLimitContinuationText('Continue the task')).toBe(false)
    expect(isUsageLimitContinuationText(`${USAGE_LIMIT_RESET_CONTINUATION_TEXT} extra`)).toBe(false)
  })
})

describe('2.1.314 firstTitleEligibleMessage (official KFs=find(Bme))', () => {
  test('finds the first non-meta user message with human/undefined origin', () => {
    const eligible = userMsg('real prompt text')
    const msgs = [
      userMsg('hook output', { isMeta: true }),
      userMsg('tool result', { toolUseResult: { ok: true } }),
      userMsg('compact summary', { isCompactSummary: true }),
      userMsg('cron tick', { origin: { kind: 'auto-continuation' } }),
      eligible,
      userMsg('second real prompt'),
    ]
    expect(firstTitleEligibleMessage(msgs as never)).toBe(eligible as never)
  })

  test('skips assistant/system messages (official Bme e.type==="user")', () => {
    const msgs = [
      { type: 'assistant', uuid: 'a', message: { content: 'hi' } },
      { type: 'system', uuid: 's', subtype: 'x' },
    ]
    expect(firstTitleEligibleMessage(msgs as never)).toBeUndefined()
  })

  test('no eligible message → undefined', () => {
    expect(firstTitleEligibleMessage([])).toBeUndefined()
  })
})

describe('2.1.314 contentToText (official em)', () => {
  test('string content returned as-is (no trim)', () => {
    expect(contentToText('  padded text  ')).toBe('  padded text  ')
  })

  test('array content: text blocks joined with \\n then trimmed; empty → null', () => {
    expect(
      contentToText([
        { type: 'text', text: 'one' },
        { type: 'image', source: {} },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one\ntwo')
    expect(contentToText([{ type: 'image', source: {} }])).toBeNull()
    expect(contentToText([])).toBeNull()
  })

  test('other types → null', () => {
    expect(contentToText(undefined)).toBeNull()
    expect(contentToText(null)).toBeNull()
    expect(contentToText(42 as never)).toBeNull()
  })
})

describe('2.1.314 extractTagContent (official ci — nesting-safe)', () => {
  test('extracts inner content of a tag', () => {
    expect(extractTagContent('<command-name>/review</command-name>', 'command-name')).toBe('/review')
  })

  test('case-insensitive tag match with attributes allowed (official lookahead [\\s>])', () => {
    expect(extractTagContent('<Command-Name foo="1">x</COMMAND-NAME>', 'command-name')).toBe('x')
  })

  test('nested same-tag: content up to the FIRST close after the open (verified against official ci transcription — nested open stays literal)', () => {
    expect(
      extractTagContent(
        '<command-args>outer <command-args>inner</command-args> tail</command-args>',
        'command-args',
      ),
    ).toBe('outer <command-args>inner')
  })

  test('missing tag / unbalanced / empty input → null', () => {
    expect(extractTagContent('no tags here', 'command-name')).toBeNull()
    expect(extractTagContent('<command-name>unclosed', 'command-name')).toBeNull()
    expect(extractTagContent('', 'command-name')).toBeNull()
    expect(extractTagContent('<command-name>x</command-name>', '')).toBeNull()
  })

  test('closing tag before opening → pair rejected (official `u=i.index+i[0].length<=t.index`); single pair → null', () => {
    expect(
      extractTagContent('</command-name><command-name>real</command-name>', 'command-name'),
    ).toBeNull()
  })

  test('closing tag before opening → scan continues to the NEXT pair (verified against official ci transcription)', () => {
    expect(
      extractTagContent(
        '</command-name><command-name>a</command-name> mid <command-name>b</command-name>',
        'command-name',
      ),
    ).toBe('b')
  })
})

describe('2.1.314 parseSlashCommand / startsAsKnownCommand (official yX / l7n)', () => {
  test('splits /name args at first whitespace, trims args', () => {
    expect(parseSlashCommand('/review src/app.ts --deep')).toEqual({
      name: 'review',
      args: 'src/app.ts --deep',
    })
    expect(parseSlashCommand('/review')).toEqual({ name: 'review', args: '' })
    expect(parseSlashCommand('review x')).toEqual({ name: 'review', args: 'x' })
  })

  test('startsAsKnownCommand: alphanumeric:_- prefix name check (official l7n)', () => {
    const known = (n: string): boolean => n === 'review'
    expect(startsAsKnownCommand('/review foo', known)).toBe(true)
    expect(startsAsKnownCommand('  /review', known)).toBe(true) // trimStart
    expect(startsAsKnownCommand('/unknown foo', known)).toBe(false)
    expect(startsAsKnownCommand('review foo', known)).toBe(false) // no leading slash
    // first-whitespace-token fallback: `/ns:review extra` where the regex
    // name is `ns:review` — both the regex token and the whitespace token
    // are tried (official `h!==s` branch).
    expect(startsAsKnownCommand('/review\tfoo', known)).toBe(true)
  })
})

describe('2.1.314 isSensitiveTitleInput (official Xhn, URe)', () => {
  test('sensitive command with args → true (URe: isSensitive===true)', () => {
    const cmds = [promptCommand({ isSensitive: true })]
    expect(isSensitiveTitleInput('/security-review some-args', cmds)).toBe(true)
  })

  test('sensitive command with EMPTY args → false (URe: `if(n.trim()==="")return!1`)', () => {
    const cmds = [promptCommand({ isSensitive: true })]
    expect(isSensitiveTitleInput('/security-review', cmds)).toBe(false)
    expect(isSensitiveTitleInput('/security-review   ', cmds)).toBe(false)
  })

  test('function-form isSensitive receives the args (URe: typeof r==="function"?r(n))', () => {
    const cmds = [promptCommand({ isSensitive: (args: string) => args.includes('token') })]
    expect(isSensitiveTitleInput('/security-review my-token=abc', cmds)).toBe(true)
    expect(isSensitiveTitleInput('/security-review plain', cmds)).toBe(false)
  })

  test('non-command text → false', () => {
    expect(isSensitiveTitleInput('plain prose', [promptCommand()])).toBe(false)
  })

  test('unknown command → false (secret-scan branch omitted; see module docs)', () => {
    expect(isSensitiveTitleInput('/mystery arg', [promptCommand()])).toBe(false)
  })

  test('pill directly after command name is spaced before parsing (official qR rewrite)', () => {
    const cmds = [promptCommand({ isSensitive: true })]
    // `/security-review[Pasted text #1] ...` → qR rewrites to
    // `/security-review [Pasted text #1] ...` so the name still resolves.
    expect(isSensitiveTitleInput('/security-review[Pasted text #1] tail', cmds)).toBe(true)
  })
})

describe('2.1.408 review P3-2 titleInputFromDispatchedMessage — REPL wiring mapping (dispatched message → official uzn)', () => {
  const commands = [promptCommand()]

  test('undefined message → null', () => {
    expect(titleInputFromDispatchedMessage(undefined, commands)).toBeNull()
  })

  test('non-user message → null (content extraction is user-only, as at the REPL site)', () => {
    const assistant = {
      type: 'assistant',
      message: { role: 'assistant', content: 'some assistant prose that is long enough' },
    } as never
    expect(titleInputFromDispatchedMessage(assistant, commands)).toBeNull()
  })

  test('prose user message → the prose (flag value is irrelevant for prose)', () => {
    const msg = userMsg('please refactor the auth module') as never
    expect(titleInputFromDispatchedMessage(msg, commands)).toBe(
      'please refactor the auth module',
    )
  })

  test('queueSkipSlashCommands stays undefined → dispatchesSlashCommands=true: known command + human origin titles via zMr', () => {
    const msg = userMsg('/security-review deep', {
      origin: { kind: 'human' },
    }) as never
    expect(titleInputFromDispatchedMessage(msg, commands)).toBe(
      '/security-review deep\nRun a security review of the current branch',
    )
  })

  test('known command without a human origin → null (zMr $l gate still applies through the helper)', () => {
    const msg = userMsg('/security-review deep') as never
    expect(titleInputFromDispatchedMessage(msg, commands)).toBeNull()
  })

  test('DOCUMENTED DIVERGENCE: `/`-leading text from a skip-flagged dispatch is titled where the official would skip', () => {
    // The official derives titles from the QUEUE ITEM (skipSlashCommands
    // visible) → uzn returns null for `/unknown-command` text under skip.
    // OCC derives from the dispatched message, which does not carry the
    // flag → undefined → dispatchesSlashCommands=true → unknown slash text
    // falls into zMr's raw-text branch and IS titled. Pinned so a future
    // message-surface change (stamping the flag) must update this test
    // deliberately.
    const msg = userMsg('/shrug please look into the flaky e2e suite') as never
    expect(titleInputFromDispatchedMessage(msg, commands)).toBe(
      '/shrug please look into the flaky e2e suite',
    )
    // Contrast: the same content with the official skip flag → null.
    expect(
      titleInputFromQueuedMessage({
        content: '/shrug please look into the flaky e2e suite',
        origin: undefined,
        queueSkipSlashCommands: true,
        commands,
      }),
    ).toBeNull()
  })
})
