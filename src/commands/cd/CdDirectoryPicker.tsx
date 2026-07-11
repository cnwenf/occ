import figures from 'figures'
import React, { useCallback, useEffect, useState } from 'react'
import { useDebounceCallback } from 'usehooks-ts'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import TextInput from '../../components/TextInput.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import {
  PromptInputFooterSuggestions,
  type SuggestionItem,
} from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { getDirectoryCompletions } from '../../utils/suggestions/directoryCompletion.js'
import { performCd } from './cdLogic.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

type Props = {
  onDone: LocalJSXCommandOnDone
}

/**
 * Directory picker rendered when `/cd` is invoked with no args.
 *
 * Offers debounced directory-path suggestions (matching `/add-dir`'s picker
 * UX) and applies the same resolve+chdir sequence as the direct `/cd <path>`
 * path. claude-code 2.1.206 #1.
 */
export function CdDirectoryPicker({ onDone }: Props): React.ReactElement {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [selected, setSelected] = useState(0)

  const fetchSuggestions = useCallback(async (path: string) => {
    if (!path) {
      setSuggestions([])
      setSelected(0)
      return
    }
    const completions = await getDirectoryCompletions(path)
    setSuggestions(completions)
    setSelected(0)
  }, [])
  const debouncedFetch = useDebounceCallback(fetchSuggestions, 100)

  useEffect(() => {
    debouncedFetch(value)
  }, [value, debouncedFetch])

  const applySuggestion = useCallback((suggestion: SuggestionItem) => {
    setValue(suggestion.id + '/')
    setError(null)
  }, [])

  const submit = useCallback(
    (path: string) => {
      const result = performCd(path)
      if (result.ok) {
        onDone(result.message, { display: 'system' })
      } else {
        setError(result.error)
      }
    },
    [onDone],
  )

  // Cancel on Esc (mirrors /add-dir).
  useKeybinding('confirm:no', () => onDone('Cancelled.', { display: 'system' }), {
    context: 'Settings',
  })

  const handleKeyDown = (e: KeyboardEvent) => {
    if (suggestions.length === 0) return
    if (e.key === 'tab') {
      e.preventDefault()
      const s = suggestions[selected]
      if (s) applySuggestion(s)
      return
    }
    if (e.key === 'return') {
      e.preventDefault()
      const s = suggestions[selected]
      if (s) submit(s.id + '/')
      return
    }
    if (e.key === 'up' || (e.ctrl && e.key === 'p')) {
      e.preventDefault()
      setSelected(p => (p <= 0 ? suggestions.length - 1 : p - 1))
      return
    }
    if (e.key === 'down' || (e.ctrl && e.key === 'n')) {
      e.preventDefault()
      setSelected(p => (p >= suggestions.length - 1 ? 0 : p + 1))
    }
  }

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="Change directory"
        onCancel={() => onDone('Cancelled.', { display: 'system' })}
        color="permission"
        isCancelActive={false}
        inputGuide={exitState =>
          exitState.pending ? (
            <Text>Press {exitState.keyName} again to exit</Text>
          ) : (
            <Byline>
              <KeyboardShortcutHint shortcut="Tab" action="complete" />
              <KeyboardShortcutHint
                shortcut="Enter"
                action="change directory"
              />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Settings"
                fallback="Esc"
                description="cancel"
              />
            </Byline>
          )
        }
      >
        <Box flexDirection="column" gap={1} marginX={2}>
          <Text>Enter the path to the directory:</Text>
          <Box borderDimColor borderStyle="round" marginY={1} paddingLeft={1}>
            <TextInput
              showCursor
              placeholder={`Directory path${figures.ellipsis}`}
              value={value}
              onChange={setValue}
              onSubmit={submit}
              columns={80}
              cursorOffset={value.length}
              onChangeCursorOffset={() => {}}
            />
          </Box>
          {suggestions.length > 0 && (
            <Box marginBottom={1}>
              <PromptInputFooterSuggestions
                suggestions={suggestions}
                selectedSuggestion={selected}
              />
            </Box>
          )}
          {error && <Text color="error">{error}</Text>}
        </Box>
      </Dialog>
    </Box>
  )
}
