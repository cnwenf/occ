// OCC-128 (P2) — focused linkage guard for the VISIBLE securityWarnings
// banner render path. The container test
// (securityWarningsBannerContainer306.test.tsx) renders <StatusNotices>
// directly, bypassing the production chain REPL → Messages → LogoHeader →
// StatusNotices; the tmux e2e is CI-skipped. The OCC-126 mutation protocol
// proved that deleting EITHER link below left `bun test` fully green
// (11 pass / 0 fail):
//   1. `securityWarnings={securityWarnings}` on the DISPLAYED <Messages>
//      site in src/screens/REPL.tsx (the transcript-dump site alone kept
//      a `toContain` guard satisfied), or
//   2. the `$[3] !== securityWarnings` clause of the LogoHeader memo-key
//      guard in src/components/Messages.tsx (stale-cache: the banner would
//      never re-render when the prop identity changes).
// This file pins both links with source-structural assertions: it passes at
// HEAD and fails under each of the two mutations.

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const REPL_SRC = readFileSync(
  new URL('../../screens/REPL.tsx', import.meta.url),
  'utf8',
)
const MESSAGES_SRC = readFileSync(
  new URL('../Messages.tsx', import.meta.url),
  'utf8',
)

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('OCC-128 securityWarnings render-path linkage (REPL → Messages → LogoHeader → StatusNotices)', () => {
  test('REPL.tsx passes securityWarnings to BOTH <Messages> sites (transcript dump + displayed)', () => {
    // Two sites: line ~4781 (transcriptMessages) and line ~4956
    // (displayedMessages — the one users actually see). Mutation 1 deletes
    // the displayed-site prop; the count guard catches it even though the
    // transcript site would keep a plain toContain satisfied.
    expect(
      countOccurrences(REPL_SRC, 'securityWarnings={securityWarnings}'),
    ).toBeGreaterThanOrEqual(2)
  })

  test('REPL.tsx displayed <Messages> site (messages={displayedMessages}) carries the securityWarnings prop', () => {
    // Site-scoped guard: within the single JSX opening tag that renders
    // displayedMessages, the prop must appear.
    const displayedSite = /<Messages\s[^>]*messages=\{displayedMessages\}[^>]*>/
    const match = displayedSite.exec(REPL_SRC)
    expect(match).not.toBeNull()
    expect(match![0]).toContain('securityWarnings={securityWarnings}')
  })

  test('Messages.tsx LogoHeader memo-key guard includes the securityWarnings identity check ($[3])', () => {
    // Mutation 2 deletes `$[3] !== securityWarnings` from the guard, letting
    // the memoized subtree serve a stale banner when the prop changes.
    expect(MESSAGES_SRC).toContain('$[3] !== securityWarnings')
    // The memo cache must also STORE the key, or the guard never updates.
    expect(MESSAGES_SRC).toContain('$[3] = securityWarnings')
  })

  test('Messages.tsx threads the prop: declaration, destructure, LogoHeader call, StatusNotices feed', () => {
    expect(MESSAGES_SRC).toContain('securityWarnings?: string[]')
    expect(MESSAGES_SRC).toContain(
      '<LogoHeader agentDefinitions={agentDefinitions} securityWarnings={securityWarnings} />',
    )
    expect(MESSAGES_SRC).toContain(
      '<StatusNotices agentDefinitions={agentDefinitions} securityWarnings={securityWarnings} />',
    )
  })
})
