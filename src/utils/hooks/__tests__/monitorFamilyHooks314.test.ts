import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// MACRO.VERSION polyfill — mirrors repo convention (transitive imports read it).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { HooksSettings } from '../../settings/types.js'

/**
 * claude-code 2.1.314 item 33 (WP-B cluster):
 *   "Fixed hooks matching Bash not running on shell commands started by the
 *    Monitor tool; such hooks can block or ask, but not approve or rewrite
 *    those commands."
 *
 * Byte-verified against the official v314 linux-x64 binary (ALL NEW vs v312 —
 * v312 has ZERO hits for `matcherMetThroughOtherName`, `which can deny or ask
 * but not allow`, and `names Monitor`; its `throughFamilyOnly` served only the
 * pre-existing MCP stand-in machinery):
 *
 * - `hz` (family call name) @253917627:
 *     function hz(e,n){return e===Os&&$Fr(n)!==void 0?Fe:void 0}
 *   with Os="Monitor" @248904623, Fe="Bash" @246440654.
 * - `$Fr` (non-empty string command extractor) @253917406.
 * - `e0t` (input reducer to {command, description?}) @253917438:
 *     function e0t(e){let n=$Fr(e);if(n===void 0)return;return typeof e==="object"&&
 *       e!==null&&"description"in e&&typeof e.description==="string"?
 *       {command:n,description:e.description}:{command:n}}
 * - `Pxn` (hook-input transformer) @256566700:
 *     function Pxn(e){if(!("tool_name"in e)||!("tool_input"in e))return;
 *       let n=hz(e.tool_name,vU(e)),r=e0t(e.tool_input);
 *       return n===void 0||r===void 0?void 0:{...e,tool_name:n,tool_input:r}}
 * - `jN` (transform gate — BOTH flags required) @256567045:
 *     function jN(e,n){return e.throughFamilyOnly===!0&&
 *       e.matcherMetThroughOtherName===!0?Pxn(n):void 0}
 * - `cnt` (family names; Zso≡empty in OCC — no MCP stand-ins) @256569635:
 *     function cnt(e,n){let r=hz(e,n),s=Zso(e);return r===void 0?s:[...s,r]}
 * - `vU` (tool_input only for PreToolUse/PermissionRequest) @256569705:
 *     function vU(e){return(e.hook_event_name==="PreToolUse"||
 *       e.hook_event_name==="PermissionRequest")&&"tool_input"in e?e.tool_input:void 0}
 * - `wxe` (negative-pattern matcher filter) @256569840:
 *     function wxe(e,n,r){let s=cnt(e,r);return n===void 0||!/\(\?<?!|\[\^/.test(n)?s:
 *       s.filter((h)=>n.includes(h.startsWith("mcp__")?h.slice(0,h.indexOf("__",5)+2):h))}
 * - getMatchingHooks Ee/ze flag sets @256594100 + flags spread @256595900:
 *     ...ze.has(dn)&&{throughFamilyOnly:!0},
 *     ...Ee.has(dn)&&{matcherMetThroughOtherName:!0}
 * - if-condition family names (Dxn) + Monitor guard @256598900:
 *     if(dn.matcherMetThroughOtherName===!0&&yr===L&&hz(L,vU(s))!==void 0)
 *       return t(`Skipping hook: its if condition "${co}" names Monitor, and its
 *       matcher met the call only through Bash`),[];
 *     if(L!==void 0&&cnt(L,vU(s)).includes(yr))return[{...Oo,throughFamilyOnly:!0}];
 * - decision strip @256637701:
 *     if(Mr.get(ur.hook)?.throughFamilyOnly===!0){if(ur.updatedInput=void 0,
 *       ur.permissionBehavior==="allow")t(`Hook ${lt} (${AM(ur.hook)})
 *       permissionDecision=allow ignored: it matched this tool only through
 *       another of its names, which can deny or ask but not allow`),
 *       ur.permissionBehavior=void 0;if(ur.permissionRequestResult?.behavior===
 *       "allow")t(`Hook ${lt} (${AM(ur.hook)}) PermissionRequest allow ignored:
 *       it matched this tool only through another of its names, which can deny
 *       or ask but not allow`),ur.permissionRequestResult=void 0}
 *   (classifierContext strip @256634669 — no OCC surface; deny/ask/block and
 *   updatedToolOutput are NOT stripped.)
 * - stdin variant cache `Nr` @256610100 — keys "base"/"elsewhere"/"asBash";
 *   OCC ports the "asBash" slot (the jN-transformed input).
 */

// --- Mock seam (Bun's mock.module leaks across files — spread the real
// module, override narrowly, restore in afterAll). ---
const actualSnapshotModule = await import('../hooksConfigSnapshot.js')
const actualConfigModule = await import('../../config.js')
const actualAnalyticsModule = await import(
  '../../../services/analytics/index.js'
)
const actualAstModule = await import('../../bash/ast.js')

let mockedHooksConfig: HooksSettings | null = null

mock.module('../hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
  shouldAllowManagedHooksOnly: () => false,
  shouldDisableAllHooksIncludingManaged: () => false,
}))
mock.module('../../config.js', () => ({
  ...actualConfigModule,
  checkHasTrustDialogAccepted: () => true,
}))
mock.module('../../../services/analytics/index.js', () => ({
  ...actualAnalyticsModule,
  logEvent: () => {},
}))
// tree-sitter sits behind the dead TREE_SITTER_BASH feature flag in OCC, so
// the real parseForSecurity always returns 'parse-unavailable' here. Mock the
// parse seam so MonitorTool.preparePermissionMatcher (used by the if-condition
// e2e tests below) exercises its real matcher logic.
const FAKE_SIMPLE_PARSES: Record<
  string,
  { kind: 'simple'; commands: { argv: string[] }[] }
> = {
  'tail -f app.log': {
    kind: 'simple',
    commands: [{ argv: ['tail', '-f', 'app.log'] }],
  },
}
mock.module('../../bash/ast.js', () => ({
  ...actualAstModule,
  parseForSecurity: async (cmd: string) =>
    FAKE_SIMPLE_PARSES[cmd] ?? { kind: 'parse-unavailable' },
}))

afterAll(() => {
  mock.module('../hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
  mock.module('../../config.js', () => ({ ...actualConfigModule }))
  mock.module('../../../services/analytics/index.js', () => ({
    ...actualAnalyticsModule,
  }))
  mock.module('../../bash/ast.js', () => ({ ...actualAstModule }))
})

const { getMatchingHooks, executePreToolHooks } = await import('../../hooks.js')
const { MonitorTool } = await import(
  '../../../tools/MonitorTool/MonitorTool.js'
)
const { setSessionTrustAccepted } = await import('../../../bootstrap/state.js')
const family = await import('../monitorFamily314.js')

beforeAll(() => {
  setSessionTrustAccepted(true)
})

afterEach(() => {
  mockedHooksConfig = null
})

// ---------------------------------------------------------------------------
// Unit: monitorFamily314 helpers ($Fr / hz / vU / cnt / wxe / e0t / Pxn / jN)
// ---------------------------------------------------------------------------

describe('2.1.314 item 33 — extractFamilyCommand (official $Fr)', () => {
  test('non-empty string command → the command', () => {
    expect(family.extractFamilyCommand({ command: 'tail -f x' })).toBe(
      'tail -f x',
    )
  })
  test('empty string / non-string / missing command / non-object → undefined', () => {
    expect(family.extractFamilyCommand({ command: '' })).toBeUndefined()
    expect(family.extractFamilyCommand({ command: 5 })).toBeUndefined()
    expect(family.extractFamilyCommand({ ws: { url: 'wss://a' } })).toBeUndefined()
    expect(family.extractFamilyCommand(null)).toBeUndefined()
    expect(family.extractFamilyCommand('tail -f x')).toBeUndefined()
  })
})

describe('2.1.314 item 33 — familyCallName (official hz: Monitor+command → "Bash")', () => {
  test('Monitor with a shell command → "Bash"', () => {
    expect(family.familyCallName('Monitor', { command: 'tail -f x' })).toBe(
      'Bash',
    )
  })
  test('Monitor ws-only → undefined; Bash/other tools → undefined', () => {
    expect(
      family.familyCallName('Monitor', { ws: { url: 'wss://a' } }),
    ).toBeUndefined()
    expect(family.familyCallName('Bash', { command: 'ls' })).toBeUndefined()
    expect(family.familyCallName(undefined, { command: 'ls' })).toBeUndefined()
  })
})

describe('2.1.314 item 33 — hookInputToolInputForFamily (official vU gate)', () => {
  test('PreToolUse / PermissionRequest carry tool_input; other events do not', () => {
    expect(
      family.hookInputToolInputForFamily({
        hook_event_name: 'PreToolUse',
        tool_input: { a: 1 },
      }),
    ).toEqual({ a: 1 })
    expect(
      family.hookInputToolInputForFamily({
        hook_event_name: 'PermissionRequest',
        tool_input: { a: 1 },
      }),
    ).toEqual({ a: 1 })
    expect(
      family.hookInputToolInputForFamily({
        hook_event_name: 'PostToolUse',
        tool_input: { a: 1 },
      }),
    ).toBeUndefined()
    expect(
      family.hookInputToolInputForFamily({ hook_event_name: 'PreToolUse' }),
    ).toBeUndefined()
  })
})

describe('2.1.314 item 33 — familyNamesForCall (official cnt, Zso≡empty in OCC)', () => {
  test('Monitor+command → ["Bash"]; everything else → []', () => {
    expect(family.familyNamesForCall('Monitor', { command: 'x' })).toEqual([
      'Bash',
    ])
    expect(family.familyNamesForCall('Monitor', {})).toEqual([])
    expect(family.familyNamesForCall('Bash', { command: 'x' })).toEqual([])
    expect(family.familyNamesForCall(undefined, { command: 'x' })).toEqual([])
  })
})

describe('2.1.314 item 33 — familyNamesForMatcher (official wxe negative-pattern filter)', () => {
  test('no matcher or no negative syntax → names as-is', () => {
    expect(family.familyNamesForMatcher(['Bash'], undefined)).toEqual(['Bash'])
    expect(family.familyNamesForMatcher(['Bash'], 'Bash|Edit')).toEqual([
      'Bash',
    ])
  })
  test('negative lookahead / char-class matcher must TEXTUALLY include the name', () => {
    expect(family.familyNamesForMatcher(['Bash'], '(?!Bash).*')).toEqual([
      'Bash',
    ])
    expect(family.familyNamesForMatcher(['Bash'], '(?!Monitor).*')).toEqual([])
    expect(family.familyNamesForMatcher(['Bash'], '[^M].*')).toEqual([])
  })
})

describe('2.1.314 item 33 — toFamilyToolInput (official e0t reducer)', () => {
  test('keeps command + string description; drops ws/timeout_ms/persistent', () => {
    expect(
      family.toFamilyToolInput({
        command: 'c',
        description: 'd',
        ws: { url: 'wss://a' },
        timeout_ms: 300000,
        persistent: false,
      }),
    ).toEqual({ command: 'c', description: 'd' })
  })
  test('no description → {command} only; non-string description dropped', () => {
    expect(family.toFamilyToolInput({ command: 'c' })).toEqual({ command: 'c' })
    expect(
      family.toFamilyToolInput({ command: 'c', description: 7 }),
    ).toEqual({ command: 'c' })
  })
  test('no non-empty command → undefined', () => {
    expect(family.toFamilyToolInput({ command: '' })).toBeUndefined()
    expect(family.toFamilyToolInput({ ws: { url: 'wss://a' } })).toBeUndefined()
  })
})

describe('2.1.314 item 33 — toFamilyHookInput (official Pxn transformer)', () => {
  const base = {
    session_id: 's',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/w',
  }

  test('PreToolUse Monitor+command → tool_name "Bash", tool_input reduced, other keys kept', () => {
    const out = family.toFamilyHookInput({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Monitor',
      tool_input: { command: 'tail -f x', description: 'd', persistent: false },
      tool_use_id: 'tu1',
    })
    expect(out).toEqual({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'tail -f x', description: 'd' },
      tool_use_id: 'tu1',
    })
  })
  test('ws-only Monitor input → undefined (no command → no family)', () => {
    expect(
      family.toFamilyHookInput({
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'Monitor',
        tool_input: { ws: { url: 'wss://a' } },
      }),
    ).toBeUndefined()
  })
  test('PostToolUse Monitor+command → undefined (vU gates tool_input)', () => {
    expect(
      family.toFamilyHookInput({
        ...base,
        hook_event_name: 'PostToolUse',
        tool_name: 'Monitor',
        tool_input: { command: 'tail -f x' },
      }),
    ).toBeUndefined()
  })
  test('does not mutate the original hook input', () => {
    const original = {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Monitor',
      tool_input: { command: 'c', description: 'd' },
    }
    family.toFamilyHookInput(original)
    expect(original.tool_name).toBe('Monitor')
    expect(original.tool_input).toEqual({ command: 'c', description: 'd' })
  })
})

describe('2.1.314 item 33 — familyHookInputForMatched (official jN gate: BOTH flags)', () => {
  const hookInput = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Monitor',
    tool_input: { command: 'c' },
  }
  test('both flags true → transformed input', () => {
    expect(
      family.familyHookInputForMatched(
        { throughFamilyOnly: true, matcherMetThroughOtherName: true },
        hookInput,
      ),
    ).toEqual({ ...hookInput, tool_name: 'Bash' })
  })
  test('either flag missing → undefined (no transform)', () => {
    expect(
      family.familyHookInputForMatched({ throughFamilyOnly: true }, hookInput),
    ).toBeUndefined()
    expect(
      family.familyHookInputForMatched(
        { matcherMetThroughOtherName: true },
        hookInput,
      ),
    ).toBeUndefined()
    expect(family.familyHookInputForMatched({}, hookInput)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Integration: getMatchingHooks family flags / guards
// ---------------------------------------------------------------------------

function commandHookConfig(
  matcher: string | undefined,
  extra: Record<string, unknown> = {},
): HooksSettings {
  return {
    PreToolUse: [
      {
        ...(matcher === undefined ? {} : { matcher }),
        hooks: [{ type: 'command', command: 'echo x', ...extra }],
      },
    ],
  } as unknown as HooksSettings
}

function monitorPreToolInput(command?: string): never {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Monitor',
    tool_input:
      command === undefined
        ? { ws: { url: 'wss://a' }, description: 'd' }
        : { command, description: 'd' },
    tool_use_id: 'tu-33',
    session_id: 's-33',
    transcript_path: '/tmp/none.jsonl',
    cwd: process.cwd(),
  } as never
}

type Flags = {
  throughFamilyOnly?: boolean
  matcherMetThroughOtherName?: boolean
}

describe('2.1.314 item 33 — getMatchingHooks: Bash-matching hooks fire on Monitor shell commands', () => {
  test('matcher "Bash" + Monitor command call → matched with BOTH family flags', async () => {
    mockedHooksConfig = commandHookConfig('Bash')
    const matched = await getMatchingHooks(
      undefined,
      's-33',
      'PreToolUse',
      monitorPreToolInput('tail -f app.log'),
    )
    expect(matched.length).toBe(1)
    const flags = matched[0] as unknown as Flags
    expect(flags.throughFamilyOnly).toBe(true)
    expect(flags.matcherMetThroughOtherName).toBe(true)
  })

  test('matcher "Bash" + Monitor ws-only call → NOT matched ($Fr gate)', async () => {
    mockedHooksConfig = commandHookConfig('Bash')
    const matched = await getMatchingHooks(
      undefined,
      's-33',
      'PreToolUse',
      monitorPreToolInput(undefined),
    )
    expect(matched.length).toBe(0)
  })

  test('matcher "Bash" + real Bash call → matched with NO flags (direct match)', async () => {
    mockedHooksConfig = commandHookConfig('Bash')
    const matched = await getMatchingHooks(undefined, 's-33', 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    } as never)
    expect(matched.length).toBe(1)
    const flags = matched[0] as unknown as Flags
    expect(flags.throughFamilyOnly).toBeUndefined()
    expect(flags.matcherMetThroughOtherName).toBeUndefined()
  })

  test('matchers "" / "*" / "Monitor" on a Monitor command call → NO flags', async () => {
    for (const matcher of ['', '*', 'Monitor']) {
      mockedHooksConfig = commandHookConfig(matcher)
      const matched = await getMatchingHooks(
        undefined,
        's-33',
        'PreToolUse',
        monitorPreToolInput('tail -f x'),
      )
      expect(matched.length).toBe(1)
      const flags = matched[0] as unknown as Flags
      expect(flags.throughFamilyOnly).toBeUndefined()
      expect(flags.matcherMetThroughOtherName).toBeUndefined()
    }
  })

  test('PostToolUse matcher "Bash" + Monitor call → NOT matched (vU gates the family)', async () => {
    mockedHooksConfig = {
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo x' }] },
      ],
    } as unknown as HooksSettings
    const matched = await getMatchingHooks(undefined, 's-33', 'PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Monitor',
      tool_input: { command: 'tail -f x' },
      tool_response: {},
    } as never)
    expect(matched.length).toBe(0)
  })

  test('negative-lookahead matcher that omits "Bash" text → family name filtered (wxe)', async () => {
    // '^(?!Monitor).*$' regex-matches "Bash" but does NOT contain the text
    // "Bash" — official wxe drops the family name, so the hook must NOT run.
    mockedHooksConfig = commandHookConfig('^(?!Monitor).*$')
    const matched = await getMatchingHooks(
      undefined,
      's-33',
      'PreToolUse',
      monitorPreToolInput('tail -f x'),
    )
    expect(matched.length).toBe(0)
  })

  test('if "Bash(tail *)" + matcher "" on a Monitor tail call → throughFamilyOnly ONLY (official if-filter @256598900)', async () => {
    mockedHooksConfig = commandHookConfig('', { if: 'Bash(tail *)' })
    const matched = await getMatchingHooks(
      undefined,
      's-33',
      'PreToolUse',
      monitorPreToolInput('tail -f app.log'),
      [MonitorTool] as never,
    )
    expect(matched.length).toBe(1)
    const flags = matched[0] as unknown as Flags
    expect(flags.throughFamilyOnly).toBe(true)
    expect(flags.matcherMetThroughOtherName).toBeUndefined()
  })

  test('if "Bash(git *)" + matcher "" on a Monitor tail call → NOT matched (rule content fails)', async () => {
    mockedHooksConfig = commandHookConfig('', { if: 'Bash(git *)' })
    const matched = await getMatchingHooks(
      undefined,
      's-33',
      'PreToolUse',
      monitorPreToolInput('tail -f app.log'),
      [MonitorTool] as never,
    )
    expect(matched.length).toBe(0)
  })

  test('official Monitor guard: matcher "Bash" (met through family) + if "Monitor(tail *)" → SKIPPED', async () => {
    mockedHooksConfig = commandHookConfig('Bash', { if: 'Monitor(tail *)' })
    const matched = await getMatchingHooks(
      undefined,
      's-33',
      'PreToolUse',
      monitorPreToolInput('tail -f app.log'),
      [MonitorTool] as never,
    )
    expect(matched.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Integration: executePreToolHooks real-child — stdin transform + decision strip
// ---------------------------------------------------------------------------

function fakeToolUseContext(): never {
  return {
    getAppState: () => undefined,
    agentId: undefined,
    options: {},
  } as never
}

async function collect(
  gen: AsyncGenerator<unknown>,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for await (const result of gen) {
    out.push(result as Record<string, unknown>)
  }
  return out
}

const MONITOR_INPUT = { command: 'tail -f /tmp/occ33.log', description: 'd' }

describe('2.1.314 item 33 — executePreToolHooks real-child on a Monitor call', () => {
  test('family-matched hook stdin is the asBash transform (tool_name "Bash", reduced tool_input)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occ314-33-'))
    const stdinFile = join(dir, 'stdin.json')
    mockedHooksConfig = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `cat > ${stdinFile}` }],
        },
      ],
    } as unknown as HooksSettings

    await collect(
      executePreToolHooks(
        'Monitor',
        'tu-33-stdin',
        MONITOR_INPUT,
        fakeToolUseContext(),
      ),
    )

    const stdin = JSON.parse(readFileSync(stdinFile, 'utf8'))
    expect(stdin.hook_event_name).toBe('PreToolUse')
    expect(stdin.tool_name).toBe('Bash')
    expect(stdin.tool_input).toEqual({
      command: MONITOR_INPUT.command,
      description: MONITOR_INPUT.description,
    })
  }, 20_000)

  test('a direct-matched (unflagged) hook still receives the ORIGINAL Monitor stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'occ314-33-'))
    const stdinFile = join(dir, 'stdin.json')
    mockedHooksConfig = {
      PreToolUse: [
        {
          matcher: 'Monitor',
          hooks: [{ type: 'command', command: `cat > ${stdinFile}` }],
        },
      ],
    } as unknown as HooksSettings

    await collect(
      executePreToolHooks(
        'Monitor',
        'tu-33-base',
        MONITOR_INPUT,
        fakeToolUseContext(),
      ),
    )

    const stdin = JSON.parse(readFileSync(stdinFile, 'utf8'))
    expect(stdin.tool_name).toBe('Monitor')
    expect(stdin.tool_input).toEqual(MONITOR_INPUT)
  }, 20_000)

  test('family-matched hook permissionDecision=allow is STRIPPED (no allow yield)', async () => {
    mockedHooksConfig = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command:
                `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse",` +
                `"permissionDecision":"allow","permissionDecisionReason":"family allow"}}'`,
            },
          ],
        },
      ],
    } as unknown as HooksSettings

    const collected = await collect(
      executePreToolHooks(
        'Monitor',
        'tu-33-allow',
        MONITOR_INPUT,
        fakeToolUseContext(),
      ),
    )

    expect(
      collected.filter(r => 'permissionBehavior' in r && r.permissionBehavior !== undefined),
    ).toEqual([])
  }, 20_000)

  test('family-matched hook permissionDecision=deny SURVIVES (block still works)', async () => {
    mockedHooksConfig = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command:
                `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse",` +
                `"permissionDecision":"deny","permissionDecisionReason":"no tailing"}}'`,
            },
          ],
        },
      ],
    } as unknown as HooksSettings

    const collected = await collect(
      executePreToolHooks(
        'Monitor',
        'tu-33-deny',
        MONITOR_INPUT,
        fakeToolUseContext(),
      ),
    )

    const behaviors = collected
      .filter(r => 'permissionBehavior' in r)
      .map(r => r.permissionBehavior)
    expect(behaviors).toContain('deny')
  }, 20_000)

  test('family-matched hook updatedInput is STRIPPED (no rewrite)', async () => {
    mockedHooksConfig = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command:
                `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse",` +
                `"permissionDecision":"allow","updatedInput":{"command":"echo pwned"}}}'`,
            },
          ],
        },
      ],
    } as unknown as HooksSettings

    const collected = await collect(
      executePreToolHooks(
        'Monitor',
        'tu-33-rewrite',
        MONITOR_INPUT,
        fakeToolUseContext(),
      ),
    )

    expect(
      collected.filter(r => r.updatedInput !== undefined),
    ).toEqual([])
  }, 20_000)
})

// ---------------------------------------------------------------------------
// 2.1.408 review P3-4 — dedup collision rule: a throughFamilyOnly entry must
// never displace a direct-matcher entry under the same hookDedupKey (official
// `!Se(dn,L,h)` guard excludes hooks that already matched directly). The same
// `echo x` command registered under BOTH `Monitor` (direct) and `Bash`
// (family-only for a Monitor call) collides on the dedup key; plain
// keep-LAST Map semantics left the survivor flagged throughFamilyOnly when
// the Bash matcher came second, stripping the hook's legitimate
// allow/updatedInput power (jN gating) despite the direct match.
// ---------------------------------------------------------------------------

function dualMatcherConfig(directFirst: boolean): HooksSettings {
  const direct = {
    matcher: 'Monitor',
    hooks: [{ type: 'command', command: 'echo x' }],
  }
  const family = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'echo x' }],
  }
  return {
    PreToolUse: directFirst ? [direct, family] : [family, direct],
  } as unknown as HooksSettings
}

describe('2.1.408 review P3-4 — dedup prefers the direct-matcher entry over a family-only entry', () => {
  test('Monitor matcher BEFORE Bash matcher → single survivor, NO family flags', async () => {
    mockedHooksConfig = dualMatcherConfig(true)
    const matched = await getMatchingHooks(
      undefined,
      's-33',
      'PreToolUse',
      monitorPreToolInput('tail -f app.log'),
    )
    expect(matched.length).toBe(1)
    const flags = matched[0] as unknown as Flags
    expect(flags.throughFamilyOnly).toBeUndefined()
    expect(flags.matcherMetThroughOtherName).toBeUndefined()
  })

  test('Bash matcher BEFORE Monitor matcher (keep-LAST would flag it) → same survivor, NO family flags', async () => {
    mockedHooksConfig = dualMatcherConfig(false)
    const matched = await getMatchingHooks(
      undefined,
      's-33',
      'PreToolUse',
      monitorPreToolInput('tail -f app.log'),
    )
    expect(matched.length).toBe(1)
    const flags = matched[0] as unknown as Flags
    expect(flags.throughFamilyOnly).toBeUndefined()
    expect(flags.matcherMetThroughOtherName).toBeUndefined()
  })

  test('Bash-only matcher on a Monitor call → still family-flagged (no direct match to prefer)', async () => {
    mockedHooksConfig = commandHookConfig('Bash')
    const matched = await getMatchingHooks(
      undefined,
      's-33',
      'PreToolUse',
      monitorPreToolInput('tail -f app.log'),
    )
    expect(matched.length).toBe(1)
    const flags = matched[0] as unknown as Flags
    expect(flags.throughFamilyOnly).toBe(true)
    expect(flags.matcherMetThroughOtherName).toBe(true)
  })

  test('dual matchers on a real Bash call → single survivor, NO family flags (direct only)', async () => {
    mockedHooksConfig = dualMatcherConfig(false)
    const matched = await getMatchingHooks(undefined, 's-33', 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    } as never)
    expect(matched.length).toBe(1)
    const flags = matched[0] as unknown as Flags
    expect(flags.throughFamilyOnly).toBeUndefined()
    expect(flags.matcherMetThroughOtherName).toBeUndefined()
  })

  test('dual matchers on a Monitor ws-only call → only the direct Monitor matcher matches ($Fr gate), no flags', async () => {
    mockedHooksConfig = dualMatcherConfig(false)
    const matched = await getMatchingHooks(
      undefined,
      's-33',
      'PreToolUse',
      monitorPreToolInput(undefined),
    )
    expect(matched.length).toBe(1)
    const flags = matched[0] as unknown as Flags
    expect(flags.throughFamilyOnly).toBeUndefined()
  })
})
