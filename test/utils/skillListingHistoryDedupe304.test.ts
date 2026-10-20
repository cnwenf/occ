// CC 2.1.304 #59 + #31 — skill-listing dedupe via history scan + content
// digests. Replaces skillListingRewindResync301.test.ts (the pre-304
// session-state machinery it covered — sentSkillNames / suppressNext /
// resyncSentSkillNamesAfterRewind — was deleted; the history scan subsumes
// resume suppression, rewind resync, and plugin-reload resets).
//
// Official references (docs/gap-research-304/research-R4-skills-hooks.md):
//   digest  C8e: nt(JSON.stringify([Ho(e),Ldt(e)])).slice(0,16)
//   Ldt(e): e.whenToUse ? `${e.description} - ${e.whenToUse}` : e.description
//   scan    EDr: K.set(Ie,(K.get(Ie)??new Set).add(Ee?.[xe]))
//   filter     : !we?.has(void 0) && !we?.has(C8e(be))
import { createHash } from 'crypto'
import { describe, expect, test } from 'bun:test'
import type { Command } from '../../src/types/command.js'
import {
  collectSentSkillListings,
  computeSkillListingDigest,
  filterUnsentSkills,
} from '../../src/utils/attachments.js'

function makeCommand(
  name: string,
  description = `${name} description`,
  whenToUse?: string,
): Command {
  return {
    type: 'prompt',
    name,
    description,
    whenToUse,
    userInvocable: true,
    loadedFrom: 'skills',
  } as unknown as Command
}

function listingMessage(attachment: Record<string, unknown>) {
  return { type: 'attachment', attachment: { type: 'skill_listing', ...attachment } }
}

describe('computeSkillListingDigest (CC 2.1.304 #59/#31, official C8e/Ldt)', () => {
  test('matches sha256(JSON.stringify([name, description])).slice(0,16) hex', () => {
    // Arrange
    const cmd = makeCommand('skill-a', 'Does a thing')
    const expected = createHash('sha256')
      .update(JSON.stringify(['skill-a', 'Does a thing']))
      .digest('hex')
      .slice(0, 16)

    // Act & Assert
    expect(computeSkillListingDigest(cmd)).toBe(expected)
    expect(computeSkillListingDigest(cmd)).toHaveLength(16)
  })

  test('joins description and whenToUse with " - " (official Ldt)', () => {
    // Arrange
    const withWhen = makeCommand('skill-a', 'Does a thing', 'Use when testing')
    const expected = createHash('sha256')
      .update(JSON.stringify(['skill-a', 'Does a thing - Use when testing']))
      .digest('hex')
      .slice(0, 16)

    // Act & Assert
    expect(computeSkillListingDigest(withWhen)).toBe(expected)
  })

  test('digest changes when description or whenToUse changes', () => {
    // Arrange
    const base = computeSkillListingDigest(makeCommand('s', 'd', 'w'))

    // Act & Assert — same content, same digest
    expect(computeSkillListingDigest(makeCommand('s', 'd', 'w'))).toBe(base)
    // Each field participates
    expect(computeSkillListingDigest(makeCommand('s', 'd2', 'w'))).not.toBe(base)
    expect(computeSkillListingDigest(makeCommand('s', 'd', 'w2'))).not.toBe(base)
    expect(computeSkillListingDigest(makeCommand('s2', 'd', 'w'))).not.toBe(base)
    // whenToUse added/removed changes the digest
    expect(computeSkillListingDigest(makeCommand('s', 'd'))).not.toBe(base)
  })
})

describe('collectSentSkillListings (official EDr scan)', () => {
  test('returns an empty map for empty or listing-free history', () => {
    // Arrange
    const history = [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { role: 'assistant', content: [] } },
      { type: 'attachment', attachment: { type: 'queued_command' } },
      null,
      undefined,
    ]

    // Act & Assert
    expect(collectSentSkillListings(history).size).toBe(0)
  })

  test('collects name -> digest-set from a names+digests listing', () => {
    // Arrange
    const history = [
      listingMessage({
        content: 'listing',
        skillCount: 2,
        isInitial: true,
        names: ['skill-a', 'skill-b'],
        digests: ['aaaa', 'bbbb'],
      }),
    ]

    // Act
    const sent = collectSentSkillListings(history)

    // Assert
    expect(sent.size).toBe(2)
    expect(sent.get('skill-a')).toEqual(new Set(['aaaa']))
    expect(sent.get('skill-b')).toEqual(new Set(['bbbb']))
  })

  test('merges multiple listings; a re-listed name accumulates both digests', () => {
    // Arrange — skill-a re-sent later with a changed description digest
    const history = [
      listingMessage({ names: ['skill-a'], digests: ['v1'] }),
      listingMessage({ names: ['skill-a', 'skill-b'], digests: ['v2', 'w1'] }),
    ]

    // Act
    const sent = collectSentSkillListings(history)

    // Assert
    expect(sent.get('skill-a')).toEqual(new Set(['v1', 'v2']))
    expect(sent.get('skill-b')).toEqual(new Set(['w1']))
  })

  test('legacy pre-304 listing without names records nothing (full re-send)', () => {
    // Arrange — OCC pre-304 rows carry content/skillCount/isInitial only
    const history = [
      listingMessage({ content: 'listing', skillCount: 3, isInitial: true }),
    ]

    // Act & Assert — official `names:we=[]` destructure default
    expect(collectSentSkillListings(history).size).toBe(0)
  })

  test('names without digests records undefined (sent, digest unknown)', () => {
    // Arrange
    const history = [listingMessage({ names: ['skill-a'] })]

    // Act
    const sent = collectSentSkillListings(history)

    // Assert — official `Ee?.[xe]` → undefined when digests absent
    expect(sent.get('skill-a')).toEqual(new Set([undefined]))
  })

  test('names/digests length mismatch records undefined for the tail', () => {
    // Arrange
    const history = [
      listingMessage({ names: ['skill-a', 'skill-b'], digests: ['aaaa'] }),
    ]

    // Act
    const sent = collectSentSkillListings(history)

    // Assert
    expect(sent.get('skill-a')).toEqual(new Set(['aaaa']))
    expect(sent.get('skill-b')).toEqual(new Set([undefined]))
  })

  test('ignores non-array names (transcript hardening)', () => {
    // Arrange
    const history = [
      listingMessage({ names: 'not-an-array', digests: ['x'] }),
      listingMessage({ names: { evil: true } }),
    ]

    // Act & Assert
    expect(collectSentSkillListings(history).size).toBe(0)
  })
})

describe('filterUnsentSkills (official EDr filter)', () => {
  test('keeps every skill when nothing was listed yet (initial / post-compact)', () => {
    // Arrange — compaction drops prior listings from the history, so the
    // scan yields an empty map and the full listing re-sends (#59)
    const commands = [makeCommand('skill-a'), makeCommand('skill-b')]

    // Act
    const unsent = filterUnsentSkills(commands, new Map())

    // Assert
    expect(unsent).toEqual(commands)
  })

  test('drops skills whose exact digest was already listed', () => {
    // Arrange
    const a = makeCommand('skill-a', 'desc a')
    const b = makeCommand('skill-b', 'desc b')
    const sent = new Map([
      ['skill-a', new Set<string | undefined>([computeSkillListingDigest(a)])],
    ])

    // Act
    const unsent = filterUnsentSkills([a, b], sent)

    // Assert
    expect(unsent).toEqual([b])
  })

  test('keeps a listed skill whose digest changed (description edit)', () => {
    // Arrange — #31: plugin reload re-lists only changed skills
    const oldA = makeCommand('skill-a', 'old description')
    const newA = makeCommand('skill-a', 'new description')
    const sent = new Map([
      ['skill-a', new Set<string | undefined>([computeSkillListingDigest(oldA)])],
    ])

    // Act
    const unsent = filterUnsentSkills([newA], sent)

    // Assert
    expect(unsent).toEqual([newA])
  })

  test('drops a skill listed with an unknown digest (legacy, official !has(void 0))', () => {
    // Arrange — pre-304 transcript row: name known, digest undefined
    const a = makeCommand('skill-a', 'desc a')
    const sent = new Map([['skill-a', new Set<string | undefined>([undefined])]])

    // Act & Assert
    expect(filterUnsentSkills([a], sent)).toEqual([])
  })

  test('keeps a skill listed under a different digest set that lacks both markers', () => {
    // Arrange — listed before with digest v1, current digest v2, no undefined
    const a = makeCommand('skill-a', 'desc a')
    const sent = new Map([['skill-a', new Set<string | undefined>(['v1'])]])

    // Act & Assert
    expect(filterUnsentSkills([a], sent)).toEqual([a])
  })
})

describe('history-scan lifecycle (resume / rewind / compaction, #59 + #31)', () => {
  test('isInitial semantics: map empty means the next listing is initial', () => {
    // Arrange — fresh session or post-compaction context
    const emptyScan = collectSentSkillListings([])
    const scanned = collectSentSkillListings([
      listingMessage({ names: ['skill-a'], digests: ['aaaa'] }),
    ])

    // Act & Assert — getSkillListingAttachments uses `sent.size === 0`
    expect(emptyScan.size === 0).toBe(true)
    expect(scanned.size === 0).toBe(false)
  })

  test('resume: transcript listing suppresses re-send of unchanged skills', () => {
    // Arrange — resumed history already carries the prior process's listing
    const a = makeCommand('skill-a', 'desc a')
    const history = [
      listingMessage({
        names: ['skill-a'],
        digests: [computeSkillListingDigest(a)],
      }),
    ]

    // Act
    const unsent = filterUnsentSkills([a], collectSentSkillListings(history))

    // Assert — subsumes the deleted suppressNextSkillListing() latch
    expect(unsent).toEqual([])
  })

  test('rewind: removed listings leave the history, so skills re-send', () => {
    // Arrange — the slice in rewindConversationTo drops the listing message
    const a = makeCommand('skill-a', 'desc a')
    const beforeRewind = [
      listingMessage({ names: ['skill-a'], digests: [computeSkillListingDigest(a)] }),
      { type: 'user', message: { role: 'user', content: 'later turn' } },
    ]
    const afterRewind = beforeRewind.slice(0, 0) // rewound past the listing

    // Act & Assert — subsumes the deleted resyncSentSkillNamesAfterRewind()
    expect(filterUnsentSkills([a], collectSentSkillListings(beforeRewind))).toEqual([])
    expect(filterUnsentSkills([a], collectSentSkillListings(afterRewind))).toEqual([a])
  })
})
