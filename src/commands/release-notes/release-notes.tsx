import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  fetchAndStoreChangelog,
  getAllReleaseNotes,
  getStoredChangelog,
} from '../../utils/releaseNotes.js'

type ReleaseNoteSet = Array<[string, string[]]>

/**
 * Format release notes into flat display lines (one block per version):
 *   "Version X:" header followed by "· note" bullets.
 */
function formatReleaseNoteLines(notes: ReleaseNoteSet): string[] {
  return notes.flatMap(([version, versionNotes]) => [
    `Version ${version}:`,
    ...versionNotes.map(note => `· ${note}`),
  ])
}

/**
 * E25 (2.1.92): /release-notes interactive "What's new" panel. Mirrors the
 * 2.1.200 binary panel descriptor:
 *   {title:"What's new", lines, footer:"/release-notes for more",
 *    emptyMessage:"Check the Claude Code changelog for updates"}
 * Press q / Esc to dismiss.
 */
function ReleaseNotesPanel({
  notes,
  onDone,
}: {
  notes: ReleaseNoteSet
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}): React.ReactNode {
  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      onDone(undefined, { display: 'skip' })
    }
  })
  const lines = formatReleaseNoteLines(notes)
  return (
    <Box flexDirection="column">
      <Text bold={true}>What's new</Text>
      {lines.length === 0 ? (
        <Text dimColor={true}>Check the Claude Code changelog for updates</Text>
      ) : (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}
      {lines.length > 0 ? (
        <Text dimColor={true}>/release-notes for more</Text>
      ) : null}
    </Box>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  // Best-effort fetch with a 500ms timeout (mirrors the prior non-interactive
  // impl); fall back to the cached changelog on failure.
  let notes: ReleaseNoteSet = []
  try {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(rej => reject(new Error('Timeout')), 500, reject)
    })
    await Promise.race([fetchAndStoreChangelog(), timeoutPromise])
    notes = getAllReleaseNotes(await getStoredChangelog())
  } catch {
    // fetch failed or timed out — fall through to cached notes
  }
  if (notes.length === 0) {
    try {
      notes = getAllReleaseNotes(await getStoredChangelog())
    } catch {
      // no cached notes either — render the empty-message panel
    }
  }
  return <ReleaseNotesPanel notes={notes} onDone={onDone} />
}
