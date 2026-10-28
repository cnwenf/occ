import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as configModule from '../../config.js'
import { getGlobalConfig, saveGlobalConfig } from '../../config.js'
import {
  buildSecurityWarningSeenKey,
  filterUnseenSecurityWarnings,
  markSecurityWarningsSeen,
  routeStartupPermissionWarnings,
  buildSecurityWarningRow,
  SEEN_SECURITY_WARNINGS_CAP,
  type StartupSecurityWarningRow,
} from '../startupSecurityWarnings.js'

/**
 * CC 2.1.311 Item 70 — startup permission warnings shown once per user.
 * Official shapes byte-verified against the v311 binary:
 *  - `var a=256` @258610748 — persisted seen-list cap.
 *  - `xvs` @258610758 — filter:
 *    `function xvs(e){let n=new Set(yi(ue().seenSecurityWarnings));
 *     return e.filter((r)=>r.seenKey===void 0||!n.has(r.seenKey))}`
 *  - `Pvs` @258610879 — mark-seen:
 *    `if(e.length===0)return; xe((r)=>{let i=yi(r.seenSecurityWarnings),
 *     o=new Set(i),t=L(e).filter((s)=>!o.has(s));if(t.length===0)return r;
 *     return{...r,seenSecurityWarnings:[...i,...t].slice(-a)}})`
 *    (L ≡ [...new Set(…)] dedupe, yi ≡ string-array normalizer,
 *     slice(-a) keeps the NEWEST 256 — oldest entries are evicted).
 *  - `fe` @256832132 —
 *    `function fe(e){return xe("sha256").update(e.join("\n")).digest("hex")}`
 *    (xe ≡ node:crypto createHash).
 *  - seenKey builder `oe` @256851566 —
 *    `{text:o,seenKey:fe([e.source,n,o])}` (n = settings path for source).
 *  - emission site @258740951 —
 *    `_s.push(...xvs(Wo.securityWarnings.map((s)=>({...s,text:pn(s.text)}))))`
 *    (text sanitized at emission; seenKey is built from the RAW text).
 *  - config key `seenSecurityWarnings` @116993972/@241899727 (v310: 0 hits).
 */

function sha256Hex(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

function persistedSeen(): string[] {
  return (
    (getGlobalConfig() as unknown as { seenSecurityWarnings?: string[] })
      .seenSecurityWarnings ?? []
  )
}

function setPersistedSeen(keys: string[]): void {
  saveGlobalConfig(
    current =>
      ({ ...current, seenSecurityWarnings: keys }) as typeof current,
  )
}

function row(text: string, seenKey?: string): StartupSecurityWarningRow {
  return seenKey === undefined ? { text } : { text, seenKey }
}

beforeEach(() => {
  setPersistedSeen([])
})

describe('2.1.311 Item70 buildSecurityWarningSeenKey (official fe @256832132)', () => {
  test('is sha256 hex of [source, settingsPath, text] joined by newline', () => {
    const key = buildSecurityWarningSeenKey({
      source: 'policySettings',
      settingsPath: '/Library/Application Support/ClaudeCode/managed-settings.json',
      text: 'Deny rule Bash(x) never matches',
    })
    expect(key).toBe(
      sha256Hex([
        'policySettings',
        '/Library/Application Support/ClaudeCode/managed-settings.json',
        'Deny rule Bash(x) never matches',
      ]),
    )
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  test('different text or source or path yields a different key', () => {
    const base = { source: 'userSettings', settingsPath: '/u/.claude/settings.json', text: 't' }
    expect(buildSecurityWarningSeenKey(base)).not.toBe(
      buildSecurityWarningSeenKey({ ...base, text: 't2' }),
    )
    expect(buildSecurityWarningSeenKey(base)).not.toBe(
      buildSecurityWarningSeenKey({ ...base, source: 'projectSettings' }),
    )
    expect(buildSecurityWarningSeenKey(base)).not.toBe(
      buildSecurityWarningSeenKey({ ...base, settingsPath: '/other.json' }),
    )
  })

  test('buildSecurityWarningRow carries {text, seenKey} (official oe @256851566)', () => {
    const built = buildSecurityWarningRow({
      source: 'userSettings',
      settingsPath: '/u/.claude/settings.json',
      text: 'Ask rule Y matches no tool · check for typos',
    })
    expect(built.text).toBe('Ask rule Y matches no tool · check for typos')
    expect(built.seenKey).toBe(
      sha256Hex([
        'userSettings',
        '/u/.claude/settings.json',
        'Ask rule Y matches no tool · check for typos',
      ]),
    )
  })
})

describe('2.1.311 Item70 filterUnseenSecurityWarnings (official xvs @258610758)', () => {
  test('rows whose seenKey is persisted are suppressed', () => {
    setPersistedSeen(['k1'])
    expect(filterUnseenSecurityWarnings([row('a', 'k1'), row('b', 'k2')])).toEqual([
      row('b', 'k2'),
    ])
  })

  test('rows without a seenKey are always kept (seenKey===void 0 branch)', () => {
    setPersistedSeen(['k1'])
    expect(filterUnseenSecurityWarnings([row('plain')])).toEqual([row('plain')])
  })

  test('empty persisted list keeps every row', () => {
    expect(
      filterUnseenSecurityWarnings([row('a', 'k1'), row('b', 'k2')]),
    ).toEqual([row('a', 'k1'), row('b', 'k2')])
  })

  test('malformed persisted value is normalized (official yi), not fatal', () => {
    saveGlobalConfig(
      current =>
        ({ ...current, seenSecurityWarnings: 'corrupted' }) as typeof current,
    )
    expect(filterUnseenSecurityWarnings([row('a', 'k1')])).toEqual([
      row('a', 'k1'),
    ])
    saveGlobalConfig(
      current =>
        ({
          ...current,
          seenSecurityWarnings: ['k1', 42, null],
        }) as typeof current,
    )
    expect(filterUnseenSecurityWarnings([row('a', 'k1'), row('b', 'k2')])).toEqual([
      row('b', 'k2'),
    ])
  })

  test('config read failure keeps all rows (warnings still shown)', () => {
    const spy = spyOn(configModule, 'getGlobalConfig').mockImplementation(() => {
      throw new Error('config unreadable')
    })
    try {
      expect(filterUnseenSecurityWarnings([row('a', 'k1')])).toEqual([
        row('a', 'k1'),
      ])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('2.1.311 Item70 markSecurityWarningsSeen (official Pvs @258610879)', () => {
  test('empty rows → no config write (Pvs early return)', () => {
    markSecurityWarningsSeen([])
    expect(persistedSeen()).toEqual([])
  })

  test('persists unseen keys of shown rows, skipping rows without seenKey', () => {
    markSecurityWarningsSeen([row('a', 'k1'), row('plain'), row('b', 'k2')])
    expect(persistedSeen()).toEqual(['k1', 'k2'])
  })

  test('already-persisted keys are not duplicated; no-op returns same config (return r)', () => {
    setPersistedSeen(['k1'])
    markSecurityWarningsSeen([row('a', 'k1')])
    expect(persistedSeen()).toEqual(['k1'])
    markSecurityWarningsSeen([row('b', 'k2')])
    expect(persistedSeen()).toEqual(['k1', 'k2'])
  })

  test('duplicate keys within one batch are deduped (official L=[...new Set(e)])', () => {
    markSecurityWarningsSeen([row('a', 'k1'), row('a-copy', 'k1')])
    expect(persistedSeen()).toEqual(['k1'])
  })

  test(`persisted list is capped at ${SEEN_SECURITY_WARNINGS_CAP} keeping the newest (slice(-a))`, () => {
    expect(SEEN_SECURITY_WARNINGS_CAP).toBe(256)
    const old = Array.from({ length: 250 }, (_, i) => `old${i}`)
    setPersistedSeen(old)
    const fresh = Array.from({ length: 10 }, (_, i) => `new${i}`)
    markSecurityWarningsSeen(fresh.map(k => row(`t-${k}`, k)))
    const persisted = persistedSeen()
    expect(persisted).toHaveLength(256)
    // Oldest 4 entries evicted; newest kept at the tail in append order.
    expect(persisted.slice(0, 3)).toEqual(['old4', 'old5', 'old6'])
    expect(persisted.slice(-10)).toEqual(fresh)
    expect(persisted).not.toContain('old0')
  })

  test('malformed persisted value self-heals on write (normalize before merge)', () => {
    saveGlobalConfig(
      current =>
        ({ ...current, seenSecurityWarnings: 123 }) as typeof current,
    )
    markSecurityWarningsSeen([row('a', 'k1')])
    expect(persistedSeen()).toEqual(['k1'])
  })

  test('config write failure is handled gracefully (no throw)', () => {
    const spy = spyOn(configModule, 'saveGlobalConfig').mockImplementation(() => {
      throw new Error('config unwritable')
    })
    try {
      expect(() => markSecurityWarningsSeen([row('a', 'k1')])).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('2.1.311 Item70 routeStartupPermissionWarnings — cross-launch dedup', () => {
  const HEADLESS_TEXT = {
    isNonInteractiveSession: true,
    outputFormat: 'text',
    sessionKind: undefined,
  } as const

  function stderrSpy() {
    return spyOn(process.stderr, 'write').mockImplementation(() => true)
  }

  test('launch 1 shows an unseen keyed row and persists its seenKey; launch 2 suppresses it', () => {
    const writeSpy = stderrSpy()
    try {
      const seenKey = buildSecurityWarningSeenKey({
        source: 'userSettings',
        settingsPath: '/u/.claude/settings.json',
        text: 'Deny rule Glob(path:x) never matches',
      })
      const first = routeStartupPermissionWarnings({
        ...HEADLESS_TEXT,
        warnings: [],
        securityWarnings: [
          {
            text: 'Deny rule Glob(path:x) never matches',
            source: 'userSettings',
            settingsPath: '/u/.claude/settings.json',
          },
        ],
      })
      expect(first).toEqual(['Deny rule Glob(path:x) never matches'])
      expect(persistedSeen()).toEqual([seenKey])

      // Simulated next launch: same warning, persisted seenKey → suppressed.
      const second = routeStartupPermissionWarnings({
        ...HEADLESS_TEXT,
        warnings: [],
        securityWarnings: [
          {
            text: 'Deny rule Glob(path:x) never matches',
            source: 'userSettings',
            settingsPath: '/u/.claude/settings.json',
          },
        ],
      })
      expect(second).toEqual([])
      expect(persistedSeen()).toEqual([seenKey])
    } finally {
      writeSpy.mockRestore()
    }
  })

  test('precomputed seenKey rows are honored as-is', () => {
    const writeSpy = stderrSpy()
    try {
      setPersistedSeen(['k1'])
      const rows = routeStartupPermissionWarnings({
        ...HEADLESS_TEXT,
        warnings: [],
        securityWarnings: [row('seen one', 'k1'), row('fresh one', 'k2')],
      })
      expect(rows).toEqual(['fresh one'])
      expect(persistedSeen()).toEqual(['k1', 'k2'])
    } finally {
      writeSpy.mockRestore()
    }
  })

  test('plain-string rows (legacy callers) have no seenKey: always shown, never persisted', () => {
    const writeSpy = stderrSpy()
    try {
      const rows = routeStartupPermissionWarnings({
        ...HEADLESS_TEXT,
        warnings: [],
        securityWarnings: ['Deny rule A never matches'],
      })
      expect(rows).toEqual(['Deny rule A never matches'])
      expect(persistedSeen()).toEqual([])
      // Shown again on the "next launch".
      const again = routeStartupPermissionWarnings({
        ...HEADLESS_TEXT,
        warnings: [],
        securityWarnings: ['Deny rule A never matches'],
      })
      expect(again).toEqual(['Deny rule A never matches'])
    } finally {
      writeSpy.mockRestore()
    }
  })

  test('json/stream-json/bg branch: no filtering, no mark-seen, empty rows', () => {
    const writeSpy = stderrSpy()
    try {
      const rows = routeStartupPermissionWarnings({
        isNonInteractiveSession: true,
        outputFormat: 'stream-json',
        sessionKind: undefined,
        warnings: ['json mode warning'],
        securityWarnings: [row('keyed row', 'k9')],
      })
      expect(rows).toEqual([])
      expect(persistedSeen()).toEqual([])
    } finally {
      writeSpy.mockRestore()
    }
  })

  test('seenKey hashes the RAW text while the row text is sanitized (official map-then-filter @258740951)', () => {
    const writeSpy = stderrSpy()
    try {
      const raw = '  Deny  rule\tW\nnever matches  '
      const expectedKey = sha256Hex(['userSettings', '/u/s.json', raw])
      const rows = routeStartupPermissionWarnings({
        ...HEADLESS_TEXT,
        warnings: [],
        securityWarnings: [
          { text: raw, source: 'userSettings', settingsPath: '/u/s.json' },
        ],
      })
      expect(rows).toEqual(['Deny  rule W never matches'])
      expect(persistedSeen()).toEqual([expectedKey])
    } finally {
      writeSpy.mockRestore()
    }
  })

  test('config read failure during routing still returns the rows (fail-open)', () => {
    const writeSpy = stderrSpy()
    const spy = spyOn(configModule, 'getGlobalConfig').mockImplementation(() => {
      throw new Error('config unreadable')
    })
    try {
      const rows = routeStartupPermissionWarnings({
        ...HEADLESS_TEXT,
        warnings: [],
        securityWarnings: [row('shown anyway', 'k1')],
      })
      expect(rows).toEqual(['shown anyway'])
    } finally {
      spy.mockRestore()
      writeSpy.mockRestore()
    }
  })
})
