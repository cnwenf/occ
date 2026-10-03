import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  PROJECT_PURGE_LEGACY_DESCRIPTION,
  PROJECT_PURGE_RENAME_NOTICE,
  PROJECT_PURGE_RENAME_PREFIX,
  PURGE_COMMAND_DESCRIPTION,
  emitProjectPurgeRenameNotice,
} from '../projectPurge.js'

/**
 * CC 2.1.288 #77 — `claude project purge` renamed to `claude purge`; the old
 * name still works and prints a notice.
 *
 * Official strings byte-verified against /tmp/cc-diff-288/v288/package/claude
 * (CLI command-registration chunk @216868818):
 *   dn = "`claude project purge` is now `claude purge`"
 *   Mn = "Delete all Claude Code state for a project (transcripts, tasks, file history, config entry)"
 *   legacy notice  = `${dn}. The old name still works for now.`
 *   legacy description = `${dn}. ${Mn}`
 *   top-level purge description = Mn
 */

const OFFICIAL_DN = '`claude project purge` is now `claude purge`'
const OFFICIAL_MN =
  'Delete all Claude Code state for a project (transcripts, tasks, file history, config entry)'

describe('CC 2.1.288 #77 — purge rename constants', () => {
  test('rename prefix matches official dn verbatim', () => {
    expect(PROJECT_PURGE_RENAME_PREFIX).toBe(OFFICIAL_DN)
  })

  test('top-level purge description matches official Mn verbatim', () => {
    expect(PURGE_COMMAND_DESCRIPTION).toBe(OFFICIAL_MN)
  })

  test('legacy notice matches official `${dn}. The old name still works for now.`', () => {
    expect(PROJECT_PURGE_RENAME_NOTICE).toBe(
      `${OFFICIAL_DN}. The old name still works for now.`,
    )
  })

  test('legacy description matches official `${dn}. ${Mn}`', () => {
    expect(PROJECT_PURGE_LEGACY_DESCRIPTION).toBe(`${OFFICIAL_DN}. ${OFFICIAL_MN}`)
  })
})

describe('CC 2.1.288 #77 — notice emission', () => {
  afterEach(() => {
    spyOn(process.stderr, 'write').mockRestore()
  })

  test('emitProjectPurgeRenameNotice writes the notice to stderr', () => {
    const written: string[] = []
    spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    emitProjectPurgeRenameNotice()
    expect(written.join('')).toContain(PROJECT_PURGE_RENAME_NOTICE)
  })
})

describe('CC 2.1.288 #77 — main.tsx registration', () => {
  test('registers a top-level `purge [path]` command and keeps the legacy alias', async () => {
    const src = await Bun.file(
      new URL('../../../main.tsx', import.meta.url),
    ).text()
    // New visible top-level command.
    expect(src).toContain("program.command('purge [path]')")
    // Legacy path still registered and emits the notice before running.
    expect(src).toContain('emitProjectPurgeRenameNotice()')
    // Legacy description carries the rename prefix.
    expect(src).toContain(PROJECT_PURGE_LEGACY_DESCRIPTION)
  })
})
