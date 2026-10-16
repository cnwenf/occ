import { beforeEach, describe, expect, test } from 'bun:test'
import {
  getSentSkillNamesForTest,
  isNextSkillListingSuppressedForTest,
  resyncSentSkillNamesAfterRewind,
  resetSentSkillNames,
  seedSentSkillNamesForTest,
  suppressNextSkillListing,
} from '../../src/utils/attachments.js'

// CC 2.1.301 changelog #27 — "Fixed skills no longer being listed to the model
// after using /rewind". Port of the official reconcile function `NXt`
// (v301 binary @229467265, byte-verified):
//
//   function NXt(e,n){let r=kAe.of(n);for(let s of e){
//     if(s.type!=="attachment")continue;
//     if(s.attachment.type==="skill_listing"){
//       if(r.suppressNext=!1,!s.attachment.names){
//         r.sentSkillNames.delete(""),r.resumeSeedNames=null;continue}
//       for(let h of s.attachment.names)
//         r.sentSkillNames.get("")?.delete(h),r.resumeSeedNames?.delete(h)}}}
//
// Semantics: for every REMOVED message that carried a skill_listing attachment,
// un-record its names from the dedup map so the next turn re-lists them.
// A full listing (no `names`) resets the agent's entire entry. suppressNext
// is cleared whenever a skill_listing removal is seen.
//
// OCC adaptation (vs official per-session `DIn` class state): OCC's dedup state
// is a module-scope Map keyed by agentId ('' = main thread) with no
// resumeSeedNames — so "reset the entry" = delete the agentKey, and there is
// no resume-seed to unwind.

const skillListing = (extra: Record<string, unknown> = {}) => ({
  type: 'attachment',
  attachment: {
    type: 'skill_listing',
    content: 'Available skills: ...',
    skillCount: 2,
    isInitial: true,
    ...extra,
  },
})

beforeEach(() => {
  resetSentSkillNames()
})

describe('resyncSentSkillNamesAfterRewind', () => {
  test('resets the whole entry when a removed full listing (no names) is seen', () => {
    // Arrange — OCC's own skill_listing shape carries content/skillCount/isInitial, never names
    seedSentSkillNamesForTest('', ['skill-a', 'skill-b'])
    expect(getSentSkillNamesForTest('')).toEqual(new Set(['skill-a', 'skill-b']))

    // Act
    resyncSentSkillNamesAfterRewind([skillListing()])

    // Assert — entry deleted entirely, mirroring `r.sentSkillNames.delete("")`
    expect(getSentSkillNamesForTest('')).toBeUndefined()
  })

  test('deletes only the recorded names when the removed listing carries names', () => {
    // Arrange — official writer shape: delta listings carry `names`
    seedSentSkillNamesForTest('', ['skill-a', 'skill-b', 'skill-c'])

    // Act
    resyncSentSkillNamesAfterRewind([skillListing({ names: ['skill-a', 'skill-c'] })])

    // Assert
    expect(getSentSkillNamesForTest('')).toEqual(new Set(['skill-b']))
  })

  test('tolerates names that were never recorded', () => {
    seedSentSkillNamesForTest('', ['skill-a'])
    resyncSentSkillNamesAfterRewind([skillListing({ names: ['skill-a', 'unknown-skill'] })])
    expect(getSentSkillNamesForTest('')).toEqual(new Set())
  })

  test('scopes the reset to the given agentKey, leaving other agents intact', () => {
    seedSentSkillNamesForTest('', ['main-skill'])
    seedSentSkillNamesForTest('agent-1', ['sub-skill'])

    resyncSentSkillNamesAfterRewind([skillListing()], 'agent-1')

    expect(getSentSkillNamesForTest('agent-1')).toBeUndefined()
    expect(getSentSkillNamesForTest('')).toEqual(new Set(['main-skill']))
  })

  test('clears suppressNext when a removed skill_listing is present', () => {
    // Arrange — a pending resume suppression must not survive the rewind of
    // the listing it was suppressing against
    suppressNextSkillListing()
    expect(isNextSkillListingSuppressedForTest()).toBe(true)

    // Act
    resyncSentSkillNamesAfterRewind([skillListing()])

    // Assert
    expect(isNextSkillListingSuppressedForTest()).toBe(false)
  })

  test('does not clear suppressNext when no skill_listing was removed', () => {
    suppressNextSkillListing()

    resyncSentSkillNamesAfterRewind([
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'attachment', attachment: { type: 'todo_reminder', content: [] } },
    ])

    expect(isNextSkillListingSuppressedForTest()).toBe(true)
  })

  test('ignores non-attachment messages and non-skill_listing attachments', () => {
    seedSentSkillNamesForTest('', ['skill-a'])

    resyncSentSkillNamesAfterRewind([
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: [] } },
      { type: 'attachment', attachment: { type: 'invoked_skills', skills: [] } },
      { type: 'attachment' }, // malformed — no attachment payload
      null as unknown as { type: string },
    ])

    expect(getSentSkillNamesForTest('')).toEqual(new Set(['skill-a']))
    expect(isNextSkillListingSuppressedForTest()).toBe(false)
  })

  test('handles multiple removed listings in order (delta then full reset)', () => {
    seedSentSkillNamesForTest('', ['a', 'b', 'c'])

    resyncSentSkillNamesAfterRewind([
      skillListing({ names: ['a'] }), // delta: drops 'a'
      skillListing({ names: ['b'] }), // delta: drops 'b'
      skillListing(), // full listing: resets whatever remains
    ])

    expect(getSentSkillNamesForTest('')).toBeUndefined()
  })

  test('is a no-op on an empty removed list (and with no prior state)', () => {
    resyncSentSkillNamesAfterRewind([])
    expect(getSentSkillNamesForTest('')).toBeUndefined()

    // names-branch with no seeded entry must not create one
    resyncSentSkillNamesAfterRewind([skillListing({ names: ['x'] })])
    expect(getSentSkillNamesForTest('')).toBeUndefined()
  })

  test('ignores non-array names payloads (transcript hardening)', () => {
    seedSentSkillNamesForTest('', ['a'])
    // A truthy non-iterable `names` would throw in the official for-of; OCC
    // guards with Array.isArray (transcripts are validated at load, but the
    // resync runs over in-memory messages that may predate validation).
    resyncSentSkillNamesAfterRewind([skillListing({ names: 'not-an-array' })])
    expect(getSentSkillNamesForTest('')).toEqual(new Set(['a']))
  })
})
