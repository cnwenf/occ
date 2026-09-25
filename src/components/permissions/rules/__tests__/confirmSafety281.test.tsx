import { describe, expect, test } from 'bun:test'
import figures from 'figures'
import * as React from 'react'
import { getEmptyToolPermissionContext } from '../../../../Tool.js'
import { Select } from '../../../CustomSelect/select.js'
import { renderToStringIsolated } from '../../../CustomSelect/__tests__/renderIsolated280.js'
import { RuleDetails } from '../PermissionRuleList.js'
import { RemoveWorkspaceDirectory } from '../RemoveWorkspaceDirectory.js'

/**
 * v2.1.281 PORT #064 — permission confirm safety (🔒 official security fix).
 *
 * Byte-level forensics on the official linux-x64 ELFs:
 *
 * - v281 renders both destructive confirms with
 *   `{focus:"cancel",hideIndexes:!0,onConfirm,onCancel}`:
 *   remove-workspace-directory confirm @229454872, delete-permission-rule
 *   confirm @229491088.
 * - v280 counterparts (@226184497 / @226221265) have NEITHER prop — the
 *   destructive confirm opened with Yes focused and rendered numeric indexes,
 *   so holding "1" could answer Yes on a destructive prompt.
 * - `hideIndexes:!0` occurrence count: v280=75 → v281=80 (+5, of which 4 are
 *   the new `focus:"cancel"` confirm sites).
 *
 * OCC mapping (verified against src/components/CustomSelect/select.tsx):
 * - `hideIndexes` (select.tsx:90) suppresses the "1."/"2." index labels AND
 *   sets disableSelection="numeric" (select.tsx:302), so digit keys can no
 *   longer select the destructive Yes option.
 * - `defaultFocusValue="no"` (select.tsx:134 → use-select-navigation.ts:528
 *   initialFocusValue) mirrors the official `focus:"cancel"`: the confirm
 *   opens with No focused, so a reflexive Enter cancels.
 */

const yesNoOptions = [
  { label: 'Yes', value: 'yes' },
  { label: 'No', value: 'no' },
]

function linesContaining(plain: string, label: string): string[] {
  return stripToLines(plain).filter(line => line.includes(label))
}

function stripToLines(plain: string): string[] {
  return plain.split('\n').map(line => line.trimEnd())
}

function renderRemoveWorkspaceDirectory(): React.ReactElement {
  return (
    <RemoveWorkspaceDirectory
      directoryPath="/tmp/occ-confirm-safety-dir"
      onRemove={() => {}}
      onCancel={() => {}}
      permissionContext={getEmptyToolPermissionContext()}
      setPermissionContext={() => {}}
    />
  )
}

function renderRuleDetails(): React.ReactElement {
  return (
    <RuleDetails
      rule={{
        source: 'userSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash', ruleContent: 'npm run test:*' },
      }}
      onDelete={() => {}}
      onCancel={() => {}}
    />
  )
}

describe('v2.1.281 #064: destructive confirms hide indexes and default to No', () => {
  test('control: a plain Yes/No Select renders numeric indexes and focuses the first option', async () => {
    // Arrange / Act — baseline proving the assertions below are observable.
    const plain = await renderToStringIsolated(
      <Select options={yesNoOptions} onChange={() => {}} onCancel={() => {}} />,
    )

    // Assert
    expect(plain).toContain('1.')
    expect(plain).toContain('2.')
    const yesLine = linesContaining(plain, 'Yes')[0]
    expect(yesLine).toContain(figures.pointer)
  })

  test('RemoveWorkspaceDirectory confirm renders no numeric indexes', async () => {
    // Arrange / Act
    const plain = await renderToStringIsolated(renderRemoveWorkspaceDirectory())

    // Assert — official v281 @229454872 `hideIndexes:!0`: no "1."/"2."
    // prefixes, so holding "1" can no longer answer Yes.
    expect(plain).toContain('Remove directory from workspace?')
    expect(plain).not.toMatch(/(^|\s)1\./)
    expect(plain).not.toMatch(/(^|\s)2\./)
  })

  test('RemoveWorkspaceDirectory confirm opens with No focused', async () => {
    // Arrange / Act
    const plain = await renderToStringIsolated(renderRemoveWorkspaceDirectory())

    // Assert — official `focus:"cancel"` → defaultFocusValue="no".
    const yesLine = linesContaining(plain, 'Yes')[0]
    const noLine = linesContaining(plain, 'No')[0]
    expect(noLine).toBeDefined()
    expect(noLine).toContain(figures.pointer)
    expect(yesLine).not.toContain(figures.pointer)
  })

  test('RuleDetails delete-rule confirm renders no numeric indexes', async () => {
    // Arrange / Act
    const plain = await renderToStringIsolated(renderRuleDetails())

    // Assert — official v281 @229491088 `hideIndexes:!0`.
    expect(plain).toContain('Are you sure you want to delete this permission rule?')
    expect(plain).not.toMatch(/(^|\s)1\./)
    expect(plain).not.toMatch(/(^|\s)2\./)
  })

  test('RuleDetails delete-rule confirm opens with No focused', async () => {
    // Arrange / Act
    const plain = await renderToStringIsolated(renderRuleDetails())

    // Assert — official `focus:"cancel"` → defaultFocusValue="no".
    const yesLine = linesContaining(plain, 'Yes')[0]
    const noLine = linesContaining(plain, 'No')[0]
    expect(noLine).toBeDefined()
    expect(noLine).toContain(figures.pointer)
    expect(yesLine).not.toContain(figures.pointer)
  })
})
