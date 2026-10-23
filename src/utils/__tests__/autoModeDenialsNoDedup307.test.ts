import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type AutoModeDenial,
  _resetDenialsForTesting,
  getAutoModeDenials,
  recordAutoModeDenial,
  removeAutoModeDenial,
} from '../autoModeDenials.js'

/**
 * CC 2.1.307 B6 — F-03 regression pins: the official denial store has NO
 * inputKey dedup on the record side. These tests exist so a future round
 * does not "fix" the store into divergence from the official binary.
 *
 * Byte-verified evidence (official v307 linux-x64 ELF, /tmp/cc-fix-307,
 * re-verified this round via `grep -aboF` + bounded `dd | tr -d '\0'`):
 *
 * - Store @258860481–258860567 (verbatim):
 *     `getDenials:()=>n.current,`
 *     `recordDenial:(h)=>{n.current=[h,...n.current.slice(0,Le-1)]},`
 *     `removeDenial:(E)=>{n.current=n.current.filter((T)=>T!==E)}`
 *   → recordDenial is an UNCONDITIONAL prepend with no dedup probe of any
 *   kind (no `.find`, no inputKey comparison, no replace-in-place);
 *   removeDenial filters by object IDENTITY (`T!==E`).
 * - Cap @258860369 (verbatim): `Le=20` — the slice keeps at most the 19
 *   newest existing rows before prepending, so the 21st record evicts the
 *   oldest row.
 * - Lookup @275125051 (verbatim):
 *     `Pt=bt.find((Mt)=>Mt.toolName===Be.name&&Mt.inputKey===xt)`
 *   → the ONLY dedup-like behavior in the whole feature is this find-FIRST
 *   lookup at decision time; it never touches the record side.
 * - Subsequent approval @275128255 (verbatim): `...L(Eo)})}return ro` —
 *   removal passes the found object itself (`Eo=Pt`), so exactly the
 *   identity-matched row leaves the store.
 *
 * Consequence (official behavior, risk-accepted): N identical auto-mode
 * denials produce N rows, and approving one retry removes only the FIRST
 * matched row — the identical siblings remain and the next identical call
 * still finds a stale prior-denial row. That is what the official binary
 * does; OCC matches it and these tests pin it.
 */

/** Distinct objects with identical content — what the record site produces
 * for repeated identical denials (fresh object literal per call). */
function makeIdenticalDenial(timestamp: number): AutoModeDenial {
  return {
    toolName: 'Bash',
    display: 'rm -rf build',
    command: 'rm -rf build',
    inputKey: '{"command":"rm -rf build"}',
    reason: 'dangerous removal',
    timestamp,
  }
}

/** Mimics the official hook lookup @275125051: find-first by
 * toolName + inputKey over `getDenials()`. */
function officialLookup(
  toolName: string,
  inputKey: string,
): AutoModeDenial | undefined {
  return getAutoModeDenials().find(
    denial => denial.toolName === toolName && denial.inputKey === inputKey,
  )
}

beforeEach(() => {
  _resetDenialsForTesting()
})

describe('F-03 pin: record side has NO inputKey dedup (official @258860506)', () => {
  test('N identical denials produce N rows, newest first (no dedup, no replace)', () => {
    // Arrange / Act — three separate denials with byte-identical content
    // (same toolName, command, inputKey, reason); only timestamp differs.
    recordAutoModeDenial(makeIdenticalDenial(100))
    recordAutoModeDenial(makeIdenticalDenial(200))
    recordAutoModeDenial(makeIdenticalDenial(300))

    // Assert — official `recordDenial:(h)=>{n.current=[h,...n.current.
    // slice(0,Le-1)]}` prepends unconditionally: 3 rows, newest first.
    // A dedup-on-record implementation would collapse these to 1 row.
    const denials = getAutoModeDenials()
    expect(denials.length).toBe(3)
    expect(denials.map(d => d.timestamp)).toEqual([300, 200, 100])
    // Every row is a distinct object (no shared-reference aliasing).
    expect(new Set(denials).size).toBe(3)
  })

  test('cap is exactly 20: the 21st record evicts the oldest row, newest 20 survive', () => {
    // Arrange / Act — official `Le=20` @258860369 with
    // `[h,...n.current.slice(0,Le-1)]`: after 21 records the store holds
    // rows 21..2 (newest first) and row 1 is gone.
    for (let i = 1; i <= 21; i++) {
      recordAutoModeDenial(makeIdenticalDenial(i))
    }

    // Assert
    const denials = getAutoModeDenials()
    expect(denials.length).toBe(20)
    expect(denials[0]?.timestamp).toBe(21) // newest recorded
    expect(denials[19]?.timestamp).toBe(2) // oldest survivor
    expect(denials.some(d => d.timestamp === 1)).toBe(false) // evicted
  })
})

describe('F-03 pin: removeDenial is identity-only (official @258860567)', () => {
  test('removes exactly the identity-matched row, leaving same-key siblings untouched', () => {
    // Arrange — three distinct rows sharing one inputKey (the no-dedup
    // record side makes this reachable in production).
    recordAutoModeDenial(makeIdenticalDenial(100))
    recordAutoModeDenial(makeIdenticalDenial(200))
    recordAutoModeDenial(makeIdenticalDenial(300))
    const middle = getAutoModeDenials()[1] as AutoModeDenial
    expect(middle.timestamp).toBe(200)

    // Act — official `removeDenial:(E)=>{n.current=n.current.filter((T)=>
    // T!==E)}`: a key-based removal would drop all three siblings; the
    // identity filter drops exactly one.
    removeAutoModeDenial(middle)

    // Assert
    expect(getAutoModeDenials().map(d => d.timestamp)).toEqual([300, 100])
  })

  test('lookup-after-approval-of-one finds the next stale sibling row (official behavior, risk-accepted)', () => {
    // This pins the reviewer's F-03 "stale row" scenario AS OFFICIAL
    // BEHAVIOR: with two identical denials recorded, approving the first
    // retry removes only the find-first match (@275125051 lookup +
    // @275128255 `L(Eo)` identity removal); the identical sibling stays,
    // so the NEXT identical call still finds a prior denial. The official
    // binary does exactly this — there is no record-side dedup and no
    // remove-all-matches. Do not "fix" it.
    const KEY = '{"command":"rm -rf build"}'
    recordAutoModeDenial(makeIdenticalDenial(100))
    recordAutoModeDenial(makeIdenticalDenial(200))

    // First approval cycle: find-first → remove the found object.
    const firstMatch = officialLookup('Bash', KEY)
    expect(firstMatch?.timestamp).toBe(200) // newest first
    removeAutoModeDenial(firstMatch as AutoModeDenial)

    // Second identical call: the stale sibling is still found.
    const secondMatch = officialLookup('Bash', KEY)
    expect(secondMatch?.timestamp).toBe(100)

    // Only after removing that row too does the lookup come up empty.
    removeAutoModeDenial(secondMatch as AutoModeDenial)
    expect(officialLookup('Bash', KEY)).toBeUndefined()
    expect(getAutoModeDenials().length).toBe(0)
  })
})
