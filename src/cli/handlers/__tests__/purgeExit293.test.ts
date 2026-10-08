import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../../utils/fsOperations.js'
import { executeDeletion } from '../projectPurge.js'
import type { PurgeItem } from '../projectPurge.js'

/**
 * CC 2.1.293 #33 — `claude purge` must exit 1 when anything failed to delete.
 *
 * Official `K` (@222469000, report §33 verbatim): after printing
 * `${i.length} item(s) failed:` + the joined failure messages, when any
 * deletion failed it also prints
 * `What could not be deleted is still on disk: fix the cause and run the command
 * again, or delete those paths by hand.` and then exits nonzero (`Jo()`).
 * OCC's `executeDeletion` already continued-on-error and listed failures but
 * fell through to exit 0 — this pins the exit(1) + the "still on disk" wording.
 *
 * NOTE: the official anti-hang path `Tt` (`Purge stopped before it finished: …`,
 * analytics `purgeStoppedByError` / `stopped_${code}`) is unreachable in OCC —
 * `deleteItem` is non-interactive and swallows per-item errors, so a purge can
 * never hang mid-flight (report §33). It is therefore documented, not ported.
 */

type Fs = ReturnType<typeof getFsImplementation>

const UNDELETABLE = '/undeletable/dir'
const DELETABLE = '/deletable/dir'

const STILL_ON_DISK =
  'What could not be deleted is still on disk: fix the cause and run the command again, or delete those paths by hand.'

describe('CC 2.1.293 #33 — purge exits 1 when a deletion fails', () => {
  let removed: string[]
  let exitCodes: number[]
  let errLines: string[]
  let logLines: string[]
  let exitSpy: ReturnType<typeof spyOn>
  let errSpy: ReturnType<typeof spyOn>
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    removed = []
    exitCodes = []
    errLines = []
    logLines = []
    setFsImplementation({
      rm: async (p: string) => {
        if (p === UNDELETABLE) {
          throw new Error('EACCES: permission denied')
        }
        removed.push(p)
      },
    } as unknown as Fs)
    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code ?? 0)
      return undefined
    }) as unknown as (code?: number) => never)
    errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errLines.push(args.map(String).join(' '))
    })
    logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    setOriginalFsImplementation()
    exitSpy.mockRestore()
    errSpy.mockRestore()
    logSpy.mockRestore()
  })

  test('a failing deletion still deletes the rest, lists failures, and exits 1', async () => {
    const items: PurgeItem[] = [
      { kind: 'dir', path: UNDELETABLE },
      { kind: 'dir', path: DELETABLE },
    ]
    await executeDeletion(items)

    // continue-on-error: the deletable item after the failure was still removed
    expect(removed).toContain(DELETABLE)
    // the one-line gap: exit(1) on failure
    expect(exitCodes).toContain(1)

    const err = errLines.join('\n')
    expect(err).toContain('1 item(s) failed:')
    expect(err).toContain(UNDELETABLE)
    expect(err).toContain(STILL_ON_DISK)
  })

  test('a clean purge deletes everything, prints the count, and never exits 1', async () => {
    const items: PurgeItem[] = [{ kind: 'dir', path: DELETABLE }]
    await executeDeletion(items)

    expect(removed).toContain(DELETABLE)
    expect(exitCodes).not.toContain(1)
    expect(logLines.join('\n')).toContain('Deleted 1 item(s).')
  })
})
