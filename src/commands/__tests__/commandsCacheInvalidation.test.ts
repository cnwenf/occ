import { describe, expect, test } from 'bun:test'
import {
  clearCommandMemoizationCaches,
  getSkillToolCommands,
  getSlashCommandToolSkills,
} from '../../commands.js'

/**
 * 2.1.216 #27 — slash-menu hot-reload of changed skills/commands.
 *
 * When a skill/command file changes mid-session, `skillChangeDetector` fires
 * and `useSkillsChange` calls `clearCommandsCache()` →
 * `clearCommandMemoizationCaches()` to invalidate the memoized command lists
 * so the next `getCommands()` re-reads from disk and the slash menu reflects
 * the new skill without a restart.
 *
 * This test locks in the cache-invalidation decision logic: the exported
 * memoized command builders (`getSkillToolCommands`, `getSlashCommandToolSkills`)
 * — which back the autocomplete menu — must have their caches cleared by
 * `clearCommandMemoizationCaches()`. If a sub-clear is dropped, hot-reload
 * silently serves stale commands and #27 regresses.
 *
 * Behavioral, no disk reads: the lodash memoize `MapCache` is populated
 * directly, cleared, and re-checked, so the test asserts the cache contract
 * without touching the filesystem.
 */
describe('2.1.216 #27 — command cache invalidation (slash-menu hot-reload)', () => {
  test('clearCommandMemoizationCaches() clears getSkillToolCommands cache', () => {
    // Arrange — populate the memoize cache without invoking the loader
    getSkillToolCommands.cache.set('fake-cwd-a', Promise.resolve([]))
    expect(getSkillToolCommands.cache.has('fake-cwd-a')).toBe(true)

    // Act
    clearCommandMemoizationCaches()

    // Assert — cache invalidated; next getCommands() re-reads from disk
    expect(getSkillToolCommands.cache.has('fake-cwd-a')).toBe(false)
  })

  test('clearCommandMemoizationCaches() clears getSlashCommandToolSkills cache', () => {
    // Arrange
    getSlashCommandToolSkills.cache.set('fake-cwd-b', Promise.resolve([]))
    expect(getSlashCommandToolSkills.cache.has('fake-cwd-b')).toBe(true)

    // Act
    clearCommandMemoizationCaches()

    // Assert
    expect(getSlashCommandToolSkills.cache.has('fake-cwd-b')).toBe(false)
  })

  test('clearCommandMemoizationCaches() is idempotent on an empty cache', () => {
    // Arrange — ensure caches are empty
    clearCommandMemoizationCaches()
    expect(getSkillToolCommands.cache.has('nope')).toBe(false)

    // Act / Assert — clearing an already-empty cache is a no-op
    expect(() => clearCommandMemoizationCaches()).not.toThrow()
  })
})
