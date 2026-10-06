import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../../Tool'
import { resolveDeclarationPrefixDecision } from '../bashPermissions'
import {
  enumerateDeclarationPrefixReadings,
  parseForSecurityFromAst,
} from '../../../utils/bash/ast.js'
import { getParserModule } from '../../../utils/bash/bashParser.js'

/**
 * Gap-research-291 Cluster A #5 — declare/typeset/export/readonly/local
 * PREFIX-assignment variable names must be reachable by deny/ask rules
 * (official 2.1.290).
 *
 * Byte-verified against the official 2.1.290 linux-x64 ELF (see
 * docs/gap-research-291/verify-290-snippets-report.md ITEM #5 and
 * docs/gap-research-291/cluster-a-bash-permissions.md #5):
 *
 *   - `Ior(e,t)` @206276467 enumerates the "which prefix names actually
 *     persist" readings: e=#names ≤3 → all 2**e bitmasks, `exhaustive:!0`;
 *     e>3 → [all-false, all-true] + one-hot per o while e≤8&&o<e, plus the
 *     observed reading t iff new, `exhaustive:!1`.
 *   - `Az(e,t,{…,declarationPrefix:s})` @206276817: bash treats `declare`/
 *     `typeset`/`export`/`readonly`/`local` as SPECIAL builtins, so a prefix
 *     assignment (`X=evil declare -x X`) PERSISTS in the shell — unlike a
 *     normal command's transient env prefix. 289 had no `declarationPrefix`
 *     param at all (0 hits); 290 has 16.
 *   - String#1 (branch/loop) @206279215, gate `B&&x.kind==="simple"`:
 *     "A variable set in front of a declaration inside a branch or loop
 *      can't be checked before it runs"
 *   - String#2 (reading-count mismatch) @206279503, gate
 *     `s!==void 0&&x.kind==="simple"&&Gt()!==s.length`:
 *     "The variables set in front of declarations in this command can't be
 *      checked before it runs"
 *   - Base parse (`s===void 0`) reports `declarationPrefixes` (count) +
 *     `declarationPrefixBashKeeps` (names) on the simple result.
 *   - `wVe(…,h,S)` @213264822 re-runs rule matching PER READING (h); the
 *     inline-script decision loop @213255257 folds: deny wins;
 *     `ot||=!Dn` (non-exhaustive → ask); `ot||= …too-complex` (any reading
 *     re-parses too-complex → ask).
 *
 * Why: 289 dropped these names from rule matching, so `Bash(evil:*)` deny
 * never saw the `$X`-resolved command name → missed deny. OCC's pre-port
 * behaviour was fail-safe (untracked `$X` → too-complex → ask) but could never
 * DENY. This port restores rule PRECISION: any persistence reading that denies
 * → deny; non-exhaustive readings → ask.
 *
 * NOTE: the AST path is DORMANT in the shipped build
 * (`feature('TREE_SITTER_BASH_SHADOW')` forces `parse-unavailable`), so these
 * pins exercise `parseForSecurityFromAst` / `resolveDeclarationPrefixDecision`
 * DIRECTLY — the same seam the future flag-flip will use.
 */

const DECL_PREFIX_BRANCH_REASON =
  "A variable set in front of a declaration inside a branch or loop can't be checked before it runs"
const DECL_PREFIX_MISMATCH_REASON =
  "The variables set in front of declarations in this command can't be checked before it runs"

function parse(cmd: string, reading?: boolean[]) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return parseForSecurityFromAst(
    cmd,
    root!,
    reading === undefined ? undefined : { declarationPrefix: reading },
  )
}

function ctxWith(
  rules: { deny?: string[]; ask?: string[]; allow?: string[] } = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: { userSettings: rules.allow ?? [] },
    alwaysDenyRules: { userSettings: rules.deny ?? [] },
    alwaysAskRules: { userSettings: rules.ask ?? [] },
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

function decide(cmd: string, ctx: ToolPermissionContext) {
  const root = getParserModule()?.parse(cmd, Number.POSITIVE_INFINITY)
  expect(root).not.toBeNull()
  return resolveDeclarationPrefixDecision(cmd, root!, ctx)
}

// --- A. parser foundation: declarationPrefixes + reading-driven persistence ---
describe('2.1.290 #5: declaration prefix persists into varScope (base parse)', () => {
  test('X=evil declare -x X && $X --run → simple, declarationPrefixes=[X], $X resolved to evil', () => {
    const r = parse('X=evil declare -x X && $X --run')
    expect(r.kind).toBe('simple')
    if (r.kind !== 'simple') return
    expect(r.declarationPrefixes).toEqual(['X'])
    // argv[0] of the SECOND command is the resolved `evil` (deny-matchable).
    const texts = r.commands.map(c => c.text)
    expect(texts).toContain('evil --run')
  })

  test('reading [true] persists X → resolved; reading [false] leaves $X untracked → too-complex', () => {
    const persist = parse('X=evil declare -x X && $X --run', [true])
    expect(persist.kind).toBe('simple')
    if (persist.kind === 'simple') {
      expect(persist.commands.map(c => c.text)).toContain('evil --run')
    }
    const transient = parse('X=evil declare -x X && $X --run', [false])
    expect(transient.kind).toBe('too-complex')
  })

  test('X=/etc/passwd export X && cat $X → simple, declarationPrefixes=[X], path resolved', () => {
    const r = parse('X=/etc/passwd export X && cat $X')
    expect(r.kind).toBe('simple')
    if (r.kind !== 'simple') return
    expect(r.declarationPrefixes).toEqual(['X'])
    expect(r.commands.map(c => c.text)).toContain('cat /etc/passwd')
  })
})

describe('2.1.290 #5: reading-count mismatch → too-complex (String#2 verbatim)', () => {
  test('1 prefix name but a 2-length reading → too-complex String#2', () => {
    const r = parse('X=evil declare -x X && $X --run', [true, false])
    expect(r).toMatchObject({
      kind: 'too-complex',
      reason: DECL_PREFIX_MISMATCH_REASON,
    })
  })
})

describe('2.1.290 #5: declaration prefix inside a branch/loop → too-complex (String#1 verbatim)', () => {
  test('if true; then X=evil declare -x X; fi && $X → too-complex String#1', () => {
    const r = parse('if true; then X=evil declare -x X; fi && $X')
    expect(r).toMatchObject({
      kind: 'too-complex',
      reason: DECL_PREFIX_BRANCH_REASON,
    })
  })
})

// --- A.regressions: non-declaration prefix stays transient; direct export unaffected ---
describe('2.1.290 #5: regressions — non-declaration prefixes and direct export unaffected', () => {
  test('X=evil cmd (non-declaration builtin) → simple, NO declarationPrefixes, X stays transient', () => {
    const r = parse('X=evil cmd')
    expect(r.kind).toBe('simple')
    if (r.kind !== 'simple') return
    expect(r.declarationPrefixes).toBeUndefined()
    expect(r.commands[0]?.envVars).toEqual([{ name: 'X', value: 'evil' }])
  })

  test('X=evil cmd && $X → too-complex (transient env prefix does NOT persist)', () => {
    // The whole point of #5's narrow scope: only SPECIAL declaration builtins
    // persist. A normal command's env prefix must stay command-local.
    const r = parse('X=evil cmd && $X')
    expect(r.kind).toBe('too-complex')
  })

  test('export FOO=bar (direct declaration_command, no prefix) → unaffected', () => {
    const r = parse('export FOO=bar')
    expect(r.kind).toBe('simple')
    if (r.kind !== 'simple') return
    expect(r.declarationPrefixes).toBeUndefined()
    expect(r.commands[0]?.argv).toEqual(['export', 'FOO=bar'])
  })
})

// --- B. readings enumeration (`Ior` port) ---
describe('2.1.290 #5: enumerateDeclarationPrefixReadings (Ior port)', () => {
  test('1 name → 2 readings, exhaustive', () => {
    const { readings, exhaustive } = enumerateDeclarationPrefixReadings(1)
    expect(exhaustive).toBe(true)
    expect(readings).toEqual([[false], [true]])
  })

  test('3 names → 8 readings (all bitmasks), exhaustive', () => {
    const { readings, exhaustive } = enumerateDeclarationPrefixReadings(3)
    expect(exhaustive).toBe(true)
    expect(readings).toHaveLength(8)
  })

  test('4 names → non-exhaustive: [all-false, all-true] + 4 one-hot = 6 readings', () => {
    const { readings, exhaustive } = enumerateDeclarationPrefixReadings(4)
    expect(exhaustive).toBe(false)
    expect(readings).toHaveLength(6)
    expect(readings[0]).toEqual([false, false, false, false])
    expect(readings[1]).toEqual([true, true, true, true])
    expect(readings[2]).toEqual([true, false, false, false])
    expect(readings[5]).toEqual([false, false, false, true])
  })

  test('observed reading appended when new (non-exhaustive branch)', () => {
    const observed = [true, false, true, false]
    const { readings, exhaustive } = enumerateDeclarationPrefixReadings(
      4,
      observed,
    )
    expect(exhaustive).toBe(false)
    expect(readings).toHaveLength(7)
    expect(readings[6]).toEqual(observed)
  })

  test('observed reading NOT duplicated when already present', () => {
    // all-true is already seed readings[1] for e>3.
    const { readings } = enumerateDeclarationPrefixReadings(4, [
      true,
      true,
      true,
      true,
    ])
    expect(readings).toHaveLength(6)
  })
})

// --- C. per-reading decision fold (deny wins; non-exhaustive → ask) ---
describe('2.1.290 #5: resolveDeclarationPrefixDecision (per-reading rule re-match)', () => {
  test('X=evil declare -x X && $X --run + deny Bash(evil:*) → deny', () => {
    const d = decide(
      'X=evil declare -x X && $X --run',
      ctxWith({ deny: ['Bash(evil:*)'] }),
    )
    expect(d?.behavior).toBe('deny')
  })

  test('X=evil declare -x X && $X --run + no rule → ask (transient reading is too-complex)', () => {
    const d = decide('X=evil declare -x X && $X --run', ctxWith({}))
    expect(d?.behavior).toBe('ask')
  })

  test('A=1 B=2 C=3 D=4 export A B C D && $A → ask (4 names, non-exhaustive readings)', () => {
    const d = decide('A=1 B=2 C=3 D=4 export A B C D && $A', ctxWith({}))
    expect(d?.behavior).toBe('ask')
  })

  test('no declaration prefix → null (caller proceeds on the normal path)', () => {
    const d = decide('X=evil cmd && echo hi', ctxWith({ deny: ['Bash(evil:*)'] }))
    expect(d).toBeNull()
  })

  test('X=evil declare -x X && $X --run + ask Bash(evil:*) → ask', () => {
    const d = decide(
      'X=evil declare -x X && $X --run',
      ctxWith({ ask: ['Bash(evil:*)'] }),
    )
    expect(d?.behavior).toBe('ask')
  })
})
