import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.293 changelog entry #46 — ASCII-first sort for agent lists +
 * announced MCP servers.
 * (docs/gap-research-293/triage-293.md §46; official vver @204175795,
 * byte-verified against /tmp/cc-diff-293/vver/package/claude.)
 *
 * Official comparator, verbatim:
 *
 *   var f=/^[\x00-\x7f]*$/;
 *   function ZCe(t,n){let e=f.test(t);if(e!==f.test(n))return e?-1:1;
 *     if(e)return t.localeCompare(n);if(t===n)return 0;return t<n?-1:1}
 *
 * Semantics: pure-ASCII strings partition BEFORE any string containing a
 * non-ASCII code point; inside the ASCII partition ordering is
 * `localeCompare` (locale-aware, case-insensitive-ish primary order);
 * otherwise ordering is UTF-16 code-unit (`<`), with 0 for equal strings.
 *
 * Official switched 6 call sites vprev→vver; OCC has 4 corresponding sites
 * (§46): `compareAgentsByName` (agentDisplay), `agent_listing_delta`
 * (attachments — wired separately), `mcp_instructions_delta`
 * (mcpInstructionsDelta), and the agent-merge/dedup return
 * (`getActiveAgentsFromList` in loadAgentsDir — official
 * `Array.from(z.values()).sort((V,Y)=>ZCe(V.agentType,Y.agentType))`
 * @214472660; OCC previously returned unsorted values).
 * The adjacent `removed.sort()` sites stay plain code-unit sort in the
 * official binary (@216012902 `z.sort()`, @214429076 `removedNames:...`) —
 * asserted below so a well-meaning "consistency" sweep can't change them.
 */

// No `mock.module` here on purpose: `logEvent` (called by mcpInstructionsDelta)
// just queues into an in-memory array while no analytics sink is attached, and
// Bun's module mocks leak across test files in the same worker (OCC-97).

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Dynamic imports so the MACRO guard above runs before these modules evaluate.
const { compareNamesAsciiFirst } = await import('../asciiFirstCompare.js')
const { compareAgentsByName } = await import(
  '../../tools/AgentTool/agentDisplay.js'
)
const { getActiveAgentsFromList } = await import(
  '../../tools/AgentTool/loadAgentsDir.js'
)
const { getMcpInstructionsDelta } = await import('../mcpInstructionsDelta.js')

type AgentLike = {
  agentType: string
  source: string
  [key: string]: unknown
}

function agent(agentType: string, source = 'projectSettings'): AgentLike {
  return { agentType, source, whenToUse: '', prompt: '' }
}

function connectedServer(name: string, instructions: string) {
  return {
    type: 'connected',
    name,
    instructions,
    capabilities: {},
    client: {},
    config: { type: 'stdio', command: 'true', args: [] },
    cleanup: async () => {},
  }
}

function instructionsDeltaMessage(addedNames: string[]) {
  return {
    type: 'attachment',
    attachment: {
      type: 'mcp_instructions_delta',
      addedNames,
      addedBlocks: addedNames.map(n => `## ${n}\nx`),
      removedNames: [],
    },
  }
}

describe('compareNamesAsciiFirst — official ZCe contract', () => {
  test('is exported as a function', () => {
    expect(typeof compareNamesAsciiFirst).toBe('function')
  })

  test('orders ASCII vs ASCII with localeCompare, not code units', () => {
    // localeCompare: 'abc' < 'abd'; code-unit ordering would agree here…
    expect(compareNamesAsciiFirst('abc', 'abd')).toBeLessThan(0)
    expect(compareNamesAsciiFirst('abd', 'abc')).toBeGreaterThan(0)
    // …but 'a' vs 'B' is the discriminator: localeCompare → -1, code-unit → 1.
    expect(compareNamesAsciiFirst('a', 'B')).toBe('a'.localeCompare('B'))
    expect(compareNamesAsciiFirst('a', 'B')).toBeLessThan(0)
    expect(compareNamesAsciiFirst('alpha', 'Beta')).toBeLessThan(0)
    expect(compareNamesAsciiFirst('zeta', 'Alpha')).toBeGreaterThan(0)
  })

  test('sorts ASCII before non-ASCII in both argument directions', () => {
    expect(compareNamesAsciiFirst('abc', '日本語')).toBe(-1)
    expect(compareNamesAsciiFirst('日本語', 'abc')).toBe(1)
    expect(compareNamesAsciiFirst('zeta', 'Ünicorn')).toBe(-1)
    expect(compareNamesAsciiFirst('Ünicorn', 'zeta')).toBe(1)
    // Latin-1 supplement still counts as non-ASCII (é > \x7f).
    expect(compareNamesAsciiFirst('cafe', 'café')).toBe(-1)
    expect(compareNamesAsciiFirst('café', 'cafe')).toBe(1)
  })

  test('orders non-ASCII vs non-ASCII by UTF-16 code unit', () => {
    // 日 U+65E5 > ア U+30A2 → positive; localeCompare would say negative.
    expect(compareNamesAsciiFirst('日本語', 'アイウ')).toBe(1)
    expect(compareNamesAsciiFirst('アイウ', '日本語')).toBe(-1)
    // Ü U+00DC < 日 U+65E5.
    expect(compareNamesAsciiFirst('Ünicorn', '日本語')).toBe(-1)
    // Ü U+00DC < ö U+00F6 → code-unit says -1, while localeCompare collates
    // ö next to o and says 1 — proves the non-ASCII partition is NOT locale.
    expect(compareNamesAsciiFirst('Ünicorn', 'österreich')).toBe(-1)
    expect('Ünicorn'.localeCompare('österreich')).toBe(1)
  })

  test('returns 0 for equal strings in both partitions', () => {
    expect(compareNamesAsciiFirst('abc', 'abc')).toBe(0)
    expect(compareNamesAsciiFirst('日本語', '日本語')).toBe(0)
    expect(compareNamesAsciiFirst('', '')).toBe(0)
  })

  test('treats the empty string and \\x7f as ASCII, \\x80 as non-ASCII', () => {
    expect(compareNamesAsciiFirst('', '日本語')).toBe(-1)
    expect(compareNamesAsciiFirst('日本語', '')).toBe(1)
    expect(compareNamesAsciiFirst('\x7f', '日本語')).toBe(-1)
    expect(compareNamesAsciiFirst('\x80', 'a')).toBe(1)
    expect(compareNamesAsciiFirst('\x80', '\x7f')).toBe(1)
  })

  test('sorts a mixed list ASCII-first, locale inside ASCII, code-unit after', () => {
    const input = ['zeta', '日本語-agent', 'alpha', 'Ünicorn', 'Beta']
    expect([...input].sort(compareNamesAsciiFirst)).toEqual([
      'alpha',
      'Beta',
      'zeta',
      'Ünicorn',
      '日本語-agent',
    ])
  })
})

describe('site: compareAgentsByName (src/tools/AgentTool/agentDisplay.ts)', () => {
  test('sorts agents ASCII-first by agentType', () => {
    const sorted = [
      agent('zeta'),
      agent('日本語-agent'),
      agent('alpha'),
      agent('Ünicorn'),
    ]
      .sort(compareAgentsByName)
      .map(a => a.agentType)
    expect(sorted).toEqual(['alpha', 'zeta', 'Ünicorn', '日本語-agent'])
  })

  test('mirrors the binary: plain localeCompare semantics (no sensitivity:base)', () => {
    // ZCe drops the `sensitivity:'base'` option OCC used to pass — with it,
    // 'Alpha' vs 'alpha' compared 0 (unstable order); the official keeps the
    // locale's tertiary case distinction.
    expect(compareAgentsByName(agent('Alpha'), agent('alpha'))).toBe(
      'Alpha'.localeCompare('alpha'),
    )
    expect(compareAgentsByName(agent('Alpha'), agent('alpha'))).not.toBe(0)
  })
})

describe('site: getActiveAgentsFromList (src/tools/AgentTool/loadAgentsDir.ts)', () => {
  test('returns the deduped active agents sorted ASCII-first', () => {
    const active = getActiveAgentsFromList([
      agent('日本語-agent', 'built-in'),
      agent('zeta', 'userSettings'),
      agent('alpha', 'projectSettings'),
      agent('Ünicorn', 'plugin'),
    ] as never) as AgentLike[]
    expect(active.map(a => a.agentType)).toEqual([
      'alpha',
      'zeta',
      'Ünicorn',
      '日本語-agent',
    ])
  })

  test('keeps the 6-layer override precedence while sorting', () => {
    const active = getActiveAgentsFromList([
      agent('zeta', 'built-in'),
      agent('alpha', 'built-in'),
      agent('zeta', 'projectSettings'),
      agent('alpha', 'policySettings'),
    ] as never) as AgentLike[]
    expect(active.map(a => a.agentType)).toEqual(['alpha', 'zeta'])
    expect(active.map(a => a.source)).toEqual(['policySettings', 'projectSettings'])
  })
})

describe('site: mcp_instructions_delta (src/utils/mcpInstructionsDelta.ts)', () => {
  test('announced added servers sort ASCII-first by name', () => {
    // 'zeta-server' is the discriminator: plain localeCompare puts 'Ünicorn'
    // before it (Ü < z in the default locale), ASCII-first puts it after every
    // pure-ASCII name.
    const delta = getMcpInstructionsDelta(
      [
        connectedServer('b-server', 'B instructions'),
        connectedServer('Ünicorn', 'U instructions'),
        connectedServer('zeta-server', 'Z instructions'),
        connectedServer('日本語-server', 'J instructions'),
      ] as never,
      [],
      [],
    )
    expect(delta?.addedNames).toEqual([
      'b-server',
      'zeta-server',
      'Ünicorn',
      '日本語-server',
    ])
    expect(delta?.addedBlocks).toEqual([
      '## b-server\nB instructions',
      '## zeta-server\nZ instructions',
      '## Ünicorn\nU instructions',
      '## 日本語-server\nJ instructions',
    ])
  })

  test('removedNames stays plain code-unit sort (official keeps .sort())', () => {
    // 'Beta-server' vs 'alpha-server' is the discriminator: plain `.sort()`
    // (code-unit) keeps B(66) before a(97); the ASCII-first comparator would
    // locale-order them to ['alpha-server','Beta-server'].
    const delta = getMcpInstructionsDelta(
      [] as never,
      [instructionsDeltaMessage(['alpha-server', 'Beta-server'])] as never,
      [],
    )
    expect(delta?.addedNames).toEqual([])
    expect(delta?.removedNames).toEqual(['Beta-server', 'alpha-server'])
  })
})

describe('wiring guard — the switched sites call the shared comparator', () => {
  // [source file, the pre-#46 sort expression that must be gone]
  const WIRED_SITES: Array<[string, string]> = [
    ['tools/AgentTool/agentDisplay.ts', 'agentType.localeCompare'],
    ['tools/AgentTool/loadAgentsDir.ts', 'agentType.localeCompare'],
    ['utils/mcpInstructionsDelta.ts', 'name.localeCompare'],
  ]

  test.each(WIRED_SITES)(
    '%s sorts with compareNamesAsciiFirst',
    (relPath, staleExpression) => {
      const source = readFileSync(join(SRC_ROOT, relPath), 'utf8')
      expect(source).toContain('compareNamesAsciiFirst')
      expect(source).not.toContain(staleExpression)
    },
  )
})

// Pending: src/utils/attachments.ts:1703 (`agent_listing_delta` added.sort) is
// owned by a concurrent agent for this round, so the one-line swap to
// `compareNamesAsciiFirst` lands separately. Un-skip once applied — the
// expectation below is the official @216012902 behavior.
test('site: agent_listing_delta added sorts ASCII-first (attachments.ts)', () => {
  // Official @216012902: `H.sort((Y,he)=>ZCe(Y.agentType,he.agentType)),z.sort()`.
  // Un-skip after the pending one-line swap in `getAgentListingDeltaAttachment`
  // (src/utils/attachments.ts) lands; `removed.sort()` must stay untouched.
  const source = readFileSync(join(SRC_ROOT, 'utils/attachments.ts'), 'utf8')
  expect(source).toContain(
    'added.sort((a, b) => compareNamesAsciiFirst(a.agentType, b.agentType))',
  )
  expect(source).not.toContain('a.agentType.localeCompare(b.agentType)')
})
