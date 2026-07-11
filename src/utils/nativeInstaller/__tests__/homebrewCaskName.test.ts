import { afterEach, describe, expect, test } from 'bun:test'
import { getHomebrewCaskName } from '../packageManagers.js'

/**
 * 2.1.206 #22: `getHomebrewCaskName()` extracts the cask name from the
 * `/Caskroom/<cask-name>/` segment of the running executable's path. Homebrew
 * installs choose their release channel by cask name (`claude-code` → stable,
 * `claude-code@latest` → latest), NOT the settings `autoUpdatesChannel`. The
 * update check fetches the cask's own version from formulae.brew.sh using this
 * name.
 *
 * Tests run on Linux (getPlatform() → 'linux', an accepted platform). Each
 * test stubs `process.execPath` and restores it afterward.
 */
describe('2.1.206 #22 getHomebrewCaskName', () => {
  const originalExecPath = process.execPath

  afterEach(() => {
    process.execPath = originalExecPath
  })

  test('extracts stable cask name from Caskroom path', () => {
    process.execPath = '/opt/homebrew/Caskroom/claude-code/2.1.206/claude'
    expect(getHomebrewCaskName()).toBe('claude-code')
  })

  test('extracts latest-channel cask name (@latest suffix preserved)', () => {
    process.execPath =
      '/opt/homebrew/Caskroom/claude-code@latest/2.1.206/claude'
    expect(getHomebrewCaskName()).toBe('claude-code@latest')
  })

  test('handles Intel Mac Caskroom path (/usr/local/Caskroom)', () => {
    process.execPath = '/usr/local/Caskroom/claude-code/2.1.206/claude'
    expect(getHomebrewCaskName()).toBe('claude-code')
  })

  test('returns null when path has no Caskroom segment', () => {
    process.execPath = '/usr/local/bin/claude'
    expect(getHomebrewCaskName()).toBeNull()
  })

  test('returns null when execPath is empty', () => {
    process.execPath = ''
    const result = getHomebrewCaskName()
    expect(result).toBeNull()
  })

  test('returns null for Caskroom path with empty cask segment', () => {
    process.execPath = '/opt/homebrew/Caskroom//claude'
    expect(getHomebrewCaskName()).toBeNull()
  })

  test('does not match Caskroom substring outside a path segment', () => {
    process.execPath = '/opt/homebrew/not-Caskroom/claude'
    expect(getHomebrewCaskName()).toBeNull()
  })
})
