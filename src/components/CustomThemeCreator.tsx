import * as React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useRegisterKeybindingContext } from '../keybindings/KeybindingContext.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import {
  normalizeColorInput,
  saveCustomTheme,
} from '../commands/theme/customThemes.js'
import { getTheme, type Theme, type ThemeName } from '../utils/theme.js'

/**
 * Curated set of user-facing color slots a custom theme can override. These are
 * the colors that most affect the look of the REPL; the full {@link Theme}
 * palette is still available by editing ~/.claude/themes/<slug>.json by hand.
 */
const COLOR_SLOTS: ReadonlyArray<{ key: keyof Theme; label: string; hint: string }> = [
  { key: 'background', label: 'Accent / border', hint: 'theme "background" — borders & accents' },
  { key: 'text', label: 'Foreground text', hint: 'main text color' },
  { key: 'claude', label: 'Brand (Claude orange)', hint: 'assistant accents' },
  { key: 'permission', label: 'Permission', hint: 'permission prompts & borders' },
  { key: 'success', label: 'Success', hint: 'success messages' },
  { key: 'error', label: 'Error', hint: 'error messages' },
  { key: 'warning', label: 'Warning', hint: 'warning messages' },
  { key: 'suggestion', label: 'Suggestion', hint: 'links & suggestions' },
]

const DEFAULT_NAME = 'My Custom Theme'

export type CustomThemeCreatorProps = {
  /** Base palette the new theme overrides. Defaults to the active theme. */
  base: ThemeName
  /** Called after the theme is persisted to ~/.claude/themes/. */
  onSaved: (theme: { slug: string; name: string; base: ThemeName }) => void
  /** Called when the user cancels (Esc). */
  onCancel: () => void
}

type FieldValue = string

/**
 * A step-based, text-input wizard for creating a custom theme. Prompts for a
 * name, then for each {@link COLOR_SLOTS} color (accepts #hex, rgb(r,g,b), or
 * ansi:name), shows a live swatch, then a review step that persists via
 * {@link saveCustomTheme}. No graphical color picker — this is a terminal.
 */
export function CustomThemeCreator({ base, onSaved, onCancel }: CustomThemeCreatorProps) {
  useRegisterKeybindingContext('CustomThemeCreator', undefined)
  const baseTheme = getTheme(base)

  // stepIndex: 0 = name, 1..N = color slots, N+1 = review
  const totalSteps = 1 + COLOR_SLOTS.length + 1
  const [stepIndex, setStepIndex] = React.useState(0)
  const [name, setName] = React.useState<string>(DEFAULT_NAME)
  const [overrides, setOverrides] = React.useState<Partial<Theme>>({})
  // Input buffer for the current step. Initialized to the current field value.
  const [value, setValue] = React.useState<FieldValue>(DEFAULT_NAME)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)

  const currentSlot = stepIndex >= 1 && stepIndex <= COLOR_SLOTS.length
    ? COLOR_SLOTS[stepIndex - 1]!
    : null
  const currentSlotValue = currentSlot
    ? ((overrides[currentSlot.key] as string | undefined) ?? (baseTheme[currentSlot.key] as string))
    : ''

  function valueForStep(idx: number): string {
    if (idx === 0) return name
    if (idx === totalSteps - 1) return ''
    const slot = COLOR_SLOTS[idx - 1]!
    return (overrides[slot.key] as string | undefined) ?? (baseTheme[slot.key] as string)
  }

  function moveTo(idx: number) {
    const clamped = Math.min(Math.max(idx, 0), totalSteps - 1)
    setError(null)
    setValue(valueForStep(clamped))
    setStepIndex(clamped)
  }

  function submit() {
    setError(null)
    // Name step
    if (stepIndex === 0) {
      const trimmed = value.trim()
      if (trimmed === '') {
        setError('Theme name cannot be empty')
        return
      }
      setName(trimmed)
      moveTo(1)
      return
    }
    // Review step → save
    if (stepIndex === totalSteps - 1) {
      void doSave()
      return
    }
    // Color step
    if (currentSlot) {
      const normalized = normalizeColorInput(value)
      if (normalized === null) {
        setError('Invalid color. Use #hex, rgb(r,g,b), or ansi:name')
        return
      }
      setOverrides(prev => ({ ...prev, [currentSlot.key]: normalized }))
      moveTo(stepIndex + 1)
    }
  }

  async function doSave() {
    setSaving(true)
    setSaveError(null)
    try {
      // Only persist overrides that differ from the base palette.
      const cleaned: Partial<Theme> = {}
      for (const slot of COLOR_SLOTS) {
        const v = overrides[slot.key] as string | undefined
        const baseVal = baseTheme[slot.key] as string
        if (v && v !== baseVal) {
          ;(cleaned as Record<string, string>)[slot.key] = v
        }
      }
      const saved = await saveCustomTheme({ name: name.trim(), base, overrides: cleaned })
      onSaved({ slug: saved.slug, name: saved.name, base: saved.base })
    } catch (e) {
      setSaveError(`Failed to save theme: ${e instanceof Error ? e.message : String(e)}`)
      setSaving(false)
    }
  }

  useInput(
    (input, key) => {
      if (saving) return
      if (key.escape) {
        onCancel()
        return
      }
      if (key.return) {
        submit()
        return
      }
      if (key.upArrow) {
        // Navigate to the previous step (without committing the buffer).
        if (stepIndex > 0) moveTo(stepIndex - 1)
        return
      }
      if (key.downArrow) {
        // Down on a color/name step advances (with validation); on review it saves.
        submit()
        return
      }
      if (key.backspace || key.delete) {
        setValue(v => v.slice(0, -1))
        setError(null)
        return
      }
      // Printable input: append. Ignore lone modifier/escape sequences.
      if (input && !key.ctrl && !key.meta && !key.escape) {
        setValue(v => v + input)
        setError(null)
      }
    },
    { isActive: !saving },
  )

  // Live swatch color: Ink <Text color> accepts rgb()/#hex/css names, not ansi:.
  const swatchColor = React.useMemo(() => {
    const v = value.trim()
    if (v.startsWith('ansi:')) return undefined
    return normalizeColorInput(value) ?? undefined
  }, [value])

  const isNameStep = stepIndex === 0
  const isColorStep = currentSlot !== null
  const isReviewStep = stepIndex === totalSteps - 1
  const stepLabel = `${stepIndex + 1}/${totalSteps}`

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text>
          <Text bold color="permission">New custom theme</Text>
          <Text dimColor>  (base: {base})</Text>
        </Text>
        <Text dimColor>Step {stepLabel}: {isNameStep ? 'theme name' : isColorStep ? currentSlot!.label : 'review & save'}</Text>
      </Box>

      {isNameStep && (
        <Box flexDirection="column">
          <Text dimColor>Enter a name for your custom theme:</Text>
          <Box>
            <Text color="suggestion">› </Text>
            <Text wrap="truncate-end">{value}</Text>
            <Text> </Text>
            <Text color="permission">▏</Text>
          </Box>
        </Box>
      )}

      {isColorStep && (
        <Box flexDirection="column">
          <Text>
            <Text bold>{currentSlot!.label}</Text>
            <Text dimColor>  {currentSlot!.hint}</Text>
          </Text>
          <Text dimColor>
            Current: {currentSlotValue}
          </Text>
          <Box>
            <Text color="suggestion">› </Text>
            <Text wrap="truncate-end">{value}</Text>
            <Text> </Text>
            <Text color="permission">▏</Text>
          </Box>
          <Box>
            {swatchColor ? (
              <Text color={swatchColor}>█████</Text>
            ) : (
              <Text dimColor>          </Text>
            )}
            <Text dimColor> {value.trim() === '' ? 'type a color' : normalizeColorInput(value) === null ? 'invalid' : 'preview'}</Text>
          </Box>
          <Text dimColor>Accepts #1e1e1e, rgb(30,30,30), or ansi:red</Text>
        </Box>
      )}

      {isReviewStep && (
        <Box flexDirection="column" gap={0}>
          <Text bold>Review: {name}</Text>
          <Text dimColor>base: {base}</Text>
          {COLOR_SLOTS.map(slot => {
            const v = (overrides[slot.key] as string | undefined) ?? (baseTheme[slot.key] as string)
            const isOverride = overrides[slot.key] !== undefined
            const previewColor = v.startsWith('ansi:') ? undefined : v
            return (
              <Box key={slot.key} flexDirection="row">
                <Text dimColor={!isOverride}>{slot.label.padEnd(22)}</Text>
                {previewColor ? <Text color={previewColor}>████</Text> : <Text dimColor>    </Text>}
                <Text dimColor={!isOverride}> {v}{isOverride ? '' : '  (base)'}</Text>
              </Box>
            )
          })}
        </Box>
      )}

      {error && <Text color="error">{error}</Text>}
      {saveError && <Text color="error">{saveError}</Text>}
      {saving && <Text color="suggestion">Saving…</Text>}

      <Box marginTop={1}>
        <Text dimColor italic>
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action={isReviewStep ? 'save & apply' : 'next'} />
            <KeyboardShortcutHint shortcut="↑" action="previous" />
            <KeyboardShortcutHint shortcut="Esc" action="cancel" />
          </Byline>
        </Text>
      </Box>
    </Box>
  )
}
