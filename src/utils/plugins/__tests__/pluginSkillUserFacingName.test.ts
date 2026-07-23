import { describe, expect, test } from 'bun:test'
import { pluginSkillUserFacingName } from '../loadPluginCommands.js'

/**
 * 2.1.216 #28 — plugin skills with a `name` frontmatter field must keep their
 * `plugin:` prefix in slash-command autocomplete.
 *
 * The slash menu builds its items via `getCommandName(cmd)` → `cmd.userFacingName()`.
 * For a plugin skill, `commandName` is the plugin-qualified invokable name
 * (`plugin:skill`). Before #28, a plugin skill whose SKILL.md set a `name:`
 * frontmatter field had `userFacingName` return that bare `name`, dropping the
 * `plugin:` prefix — so the autocomplete showed `/foo` instead of `/myplug:foo`
 * and the skill was uninvokable from the menu.
 *
 * This test locks the decision: the `name` frontmatter (display name) must NOT
 * override the plugin-qualified invokable name in the autocomplete.
 */
describe('2.1.216 #28 — plugin-skill prefix preserved in autocomplete', () => {
  test('keeps the plugin: prefix when a name frontmatter is set', () => {
    // Arrange — plugin "myplug" exports skill "foo" whose SKILL.md has
    // `name: foo` (a human-readable display name).
    const commandName = 'myplug:foo'
    const displayName = 'foo'

    // Act
    const shown = pluginSkillUserFacingName(commandName, displayName)

    // Assert — the invokable plugin-qualified name wins
    expect(shown).toBe('myplug:foo')
  })

  test('keeps the plugin: prefix for a namespaced plugin skill (plugin:ns:skill)', () => {
    const commandName = 'myplug:sub:bar'
    const displayName = 'bar'

    expect(pluginSkillUserFacingName(commandName, displayName)).toBe(
      'myplug:sub:bar',
    )
  })

  test('returns the plugin-qualified name when no name frontmatter is set', () => {
    const commandName = 'myplug:baz'
    expect(pluginSkillUserFacingName(commandName, undefined)).toBe('myplug:baz')
  })

  test('returns the command name as-is for a plugin skill with an empty name field', () => {
    const commandName = 'myplug:qux'
    expect(pluginSkillUserFacingName(commandName, '')).toBe('myplug:qux')
  })
})
