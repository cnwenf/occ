import { useEffect, useMemo, useState } from 'react'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../../keybindings/useShortcutDisplay.js'
import {
  type AutoModeDenial,
  getAutoModeDenials,
} from '../../../utils/autoModeDenials.js'
import { isScreenReaderEnabled } from '../../../utils/screenReader.js'
import { Select } from '../../CustomSelect/select.js'
import { StatusIcon } from '../../design-system/StatusIcon.js'
import { useTabHeaderFocus } from '../../design-system/Tabs.js'
import {
  MAX_COMMAND_ROWS,
  MAX_LABEL_UNITS,
  MAX_LISTED_DENIALS,
  MIN_WINDOW_WIDTH,
  WINDOW_GUTTER_COLUMNS,
  buildDenialsFooter,
  commandCutGutter,
  denialReasonDescription,
  hiddenRowsGutter,
  sanitizeDenialLabels,
  shortcutParenHint,
  truncateCommand,
  windowWrappedText,
} from './denialDisplay.js'

/**
 * CC 2.1.307 B6 — "/permissions Recently-denied rows show the command;
 * approvals name the command."
 *
 * Clean hand-written rewrite of the official `un` + `Ji` components
 * (new307.txt @16921300–16927100; UI strings @16921854 "No recent denials…",
 * @16924699 "Commands recently denied…", @16924838 "Command for row N:").
 * The official ships React-Compiler output (`_c(N)` slot memoization); this
 * port keeps the identical component structure, hook order, state flow and
 * JSX tree without the compiler scaffolding.
 *
 * Documented deviations (see docs/upstream-version-gap ledger):
 * - Denials come from the module store (`getAutoModeDenials`) instead of the
 *   official `nxe()` denials context (OCC has no such provider).
 * - `zEn` (windowed-text hook with yoga box refs + shortRows adaptive
 *   collapse) is replaced by the pure `windowWrappedText` (`wgo`) plus a
 *   `windowStart` state advanced by the ctrl+o binding; the adaptive
 *   listed-count collapse (`se`/`ie` state) and the re-render counter are
 *   omitted — `listed` is the official base `Math.min(10, denials.length)`.
 * - Select props `selectedValue` (official `Es`, unrecoverable) and
 *   `hiddenBelowUnit="denial"` are omitted — OCC's Select has neither prop.
 * - The official `Ii` multiline text wrapper (internal layout wrapper, not
 *   recoverable) maps to plain Ink `Text` with explicit `wrap` semantics.
 * - `wv` keybindings wrapper maps to OCC's `useKeybinding` hook.
 */

type DenialSelectionState = {
  approved: Set<number>
  retry: Set<number>
  denials: readonly AutoModeDenial[]
}

type Props = {
  onHeaderFocusChange?: (focused: boolean) => void
  /** Called when approved/retry state changes so parent can act on exit */
  onStateChange: (state: DenialSelectionState) => void
}

/** Official `un`: reads the denial store once; renders the empty state or `Ji`. */
export function RecentDenialsTab({
  onHeaderFocusChange,
  onStateChange,
}: Props) {
  const [denials] = useState(getAutoModeDenials)
  const isEmpty = denials.length === 0

  useEffect(() => {
    if (isEmpty) onHeaderFocusChange?.(true)
  }, [isEmpty, onHeaderFocusChange])

  useEffect(() => {
    if (isEmpty) {
      onStateChange({ approved: new Set(), retry: new Set(), denials })
    }
  }, [isEmpty, denials, onStateChange])

  if (isEmpty) {
    return (
      <Text dimColor={true}>
        No recent denials. Commands denied by the auto mode classifier will
        appear here.
      </Text>
    )
  }
  return (
    <DenialsList
      denials={denials}
      onHeaderFocusChange={onHeaderFocusChange}
      onStateChange={onStateChange}
    />
  )
}

type DenialsListProps = Props & { denials: readonly AutoModeDenial[] }

/** Official `Ji`: the denial rows + focused-row command reveal. */
function DenialsList({
  denials,
  onHeaderFocusChange,
  onStateChange,
}: DenialsListProps) {
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  useEffect(() => {
    onHeaderFocusChange?.(headerFocused)
  }, [headerFocused, onHeaderFocusChange])

  const [approved, setApproved] = useState<Set<number>>(() => new Set())
  const [retry, setRetry] = useState<Set<number>>(() => new Set())
  const [focusedIdx, setFocusedIdx] = useState(0)

  useEffect(() => {
    onStateChange({ approved, retry, denials })
  }, [approved, retry, denials, onStateChange])

  // Official `R=ee(()=>sbt(g.map(N=>N.display),{maxUnits:AS}),[g])`.
  const labels = useMemo(
    () => sanitizeDenialLabels(denials.map(d => d.display), MAX_LABEL_UNITS),
    [denials],
  )
  // Official `M=it()` (screen reader) and
  // `O=ee(()=>g.map(N=>N.command===void 0?void 0:Tr(N.command)),[g])`.
  const screenReader = isScreenReaderEnabled()
  const commandDisplays = useMemo(
    () =>
      denials.map(d =>
        d.command === undefined ? undefined : truncateCommand(d.command),
      ),
    [denials],
  )
  const focusedCommand = screenReader ? undefined : commandDisplays[focusedIdx]
  const { rows, columns } = useTerminalSize()
  const listed = Math.min(MAX_LISTED_DENIALS, denials.length)
  // Official footer `Z`: retry wins over approve; '' when nothing selected.
  const footer = buildDenialsFooter(retry.size, approved.size)

  const [windowStart, setWindowStart] = useState(0)
  useEffect(() => {
    setWindowStart(0)
  }, [denials, focusedIdx, rows, columns])
  const contentWidth = Math.max(
    MIN_WINDOW_WIDTH,
    columns - WINDOW_GUTTER_COLUMNS,
  )
  const windowed = windowWrappedText(
    focusedCommand?.text ?? '',
    contentWidth,
    MAX_COMMAND_ROWS,
    windowStart,
  )
  const hasHidden = windowed.hiddenRows > 0 || windowed.hiddenAbove > 0

  // Official `Ae=Ia("app:toggleTranscript","Global","ctrl+o")`.
  const toggleTranscriptChord = useShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  // Official `ne`/`Ke`: value passed to Select's defaultFocusValue after a
  // first-press focus so a repeated Enter toggles the same row.
  const [pressedEnterValue, setPressedEnterValue] = useState<
    string | undefined
  >(undefined)
  // Official `ke`: withheld rows are not approvable.
  const withheldIdx = useMemo(
    () =>
      new Set(
        labels
          .map((label, index) => (label.withheld ? index : -1))
          .filter(index => index >= 0),
      ),
    [labels],
  )
  // Official `Je`/`Ve`: screen-reader focus index (SR users toggle the row
  // they last heard, since the visual focus reveal is disabled under SR).
  const [srFocusedIdx, setSrFocusedIdx] = useState<number | undefined>(
    undefined,
  )

  // Official `ot`: first Enter on an unfocused row only moves focus; a second
  // press toggles approval (and clears retry) unless the row is withheld.
  const handleChange = (value: string) => {
    const idx = Number(value)
    if (screenReader) setSrFocusedIdx(idx)
    if (!screenReader && idx !== focusedIdx) {
      setFocusedIdx(idx)
      setPressedEnterValue(value)
      return
    }
    if (withheldIdx.has(idx)) return
    setApproved(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
    setRetry(prev => {
      if (!prev.has(idx)) return prev
      const next = new Set(prev)
      next.delete(idx)
      return next
    })
  }

  // Official `be`.
  const handleFocus = (value: string) => {
    if (Number(value) !== focusedIdx) setFocusedIdx(Number(value))
    if (screenReader) setSrFocusedIdx(Number(value))
    setPressedEnterValue(undefined)
  }

  // Official `dt`: bare 'r' toggles retry on the focused row (and ensures it
  // is approved); withheld rows and modifier combos are ignored.
  function handleKeyDown(event: KeyboardEvent) {
    if (headerFocused) return
    if (event.ctrl || event.meta || event.shift) return
    if (event.key !== 'r') return
    event.preventDefault()
    const idx = screenReader ? srFocusedIdx : focusedIdx
    if (idx === undefined || withheldIdx.has(idx)) return
    setRetry(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
    setApproved(prev => {
      if (prev.has(idx)) return prev
      const next = new Set(prev)
      next.add(idx)
      return next
    })
  }

  // Official `wv` binding: ctrl+o advances the reveal window while a command
  // is shown and the tab header is not focused.
  useKeybinding(
    'app:toggleTranscript',
    () => {
      if (hasHidden) setWindowStart(windowed.nextStart)
    },
    { isActive: focusedCommand !== undefined && !headerFocused },
  )

  // Official `nt`: dim whitespace-collapsed reason descriptions.
  const descriptions = useMemo(
    () => denials.map(d => denialReasonDescription(d.reason)),
    [denials],
  )

  // Official `Xe`: row options — StatusIcon + sanitized label + dim suffix.
  const options = denials.map((denial, index) => {
    const isApproved = approved.has(index)
    const suffix = retry.has(index)
      ? ' (retry)'
      : screenReader && isApproved
        ? ' (approved)'
        : ''
    const description = descriptions[index]
    return {
      label: (
        <Text>
          <StatusIcon
            status={isApproved ? 'success' : 'error'}
            withSpace={true}
          />
          {labels[index]?.text}
          <Text dimColor={true}>{suffix}</Text>
        </Text>
      ),
      value: String(index),
      ...(description && { description, dimDescription: true }),
    }
  })

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" flexShrink={0} onKeyDown={handleKeyDown}>
        <Text>Commands recently denied by the auto mode classifier.</Text>
        {screenReader &&
          commandDisplays.map((commandDisplay, index) =>
            commandDisplay === undefined ? null : (
              <Box flexDirection="column" key={index}>
                <Text>Command for row {index + 1}:</Text>
                <Text wrap="wrap">{commandDisplay.text}</Text>
                {commandDisplay.cutChars > 0 && (
                  <Text>{commandCutGutter(commandDisplay.cutChars)}</Text>
                )}
              </Box>
            ),
          )}
        <Box marginTop={1}>
          <Select
            options={options}
            onChange={handleChange}
            onFocus={handleFocus}
            defaultFocusValue={pressedEnterValue}
            visibleOptionCount={listed}
            isDisabled={headerFocused}
            onUpFromFirstItem={focusHeader}
          />
        </Box>
        {footer !== '' && (
          <Text dimColor={true} wrap="truncate-end">
            {footer}
          </Text>
        )}
        {focusedCommand !== undefined && (
          <Box
            marginTop={footer === '' ? 1 : 0}
            flexDirection="column"
          >
            <Box flexDirection="column">
              <Box flexDirection="column" flexGrow={1}>
                <Text
                  wrap={focusedCommand.needsGutter ? 'wrap' : undefined}
                >
                  {windowed.text}
                </Text>
              </Box>
              {hasHidden && (
                <Text dimColor={true} wrap="truncate-end">
                  {hiddenRowsGutter({
                    hiddenRows: windowed.hiddenRows,
                    hiddenAbove: windowed.hiddenAbove,
                    hint: headerFocused
                      ? ''
                      : shortcutParenHint(
                          toggleTranscriptChord,
                          windowed.hiddenRows > 0
                            ? 'see more'
                            : 'see the first lines',
                        ),
                    columns: contentWidth,
                  })}
                </Text>
              )}
            </Box>
            {focusedCommand.cutChars > 0 && (
              <Text dimColor={true} wrap="truncate-end">
                {commandCutGutter(focusedCommand.cutChars)}
              </Text>
            )}
          </Box>
        )}
      </Box>
    </Box>
  )
}
