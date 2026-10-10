/**
 * dataflow-004 fix — an existing-but-unreadable NON-policy settings file
 * must still produce the official 'it could not be read' warning after a
 * plugin command.
 *
 * Root cause: `parseSettingsFile` (settings.ts catch arm) only emits the
 * `errorClass: "unreadable"` record for `policySource: true`; every other
 * source's OS read failure is swallowed into `{settings: null, errors: []}`.
 * `getSettingsFileLoadWarning` never sees policySettings (early-out), so
 * before the fix the 'it could not be read' reason was dead code and a
 * chmod-000 user settings file warned about NOTHING.
 *
 * Fix under test: the warning path probes readability directly
 * (`isFileUnreadable`, via the swappable `getFsImplementation()` fs layer —
 * the same abstraction `parseSettingsFileUncached` reads through). Tests run
 * as root in CI, where a real chmod-000 file is still readable, so the
 * EACCES failure is injected at the fs-implementation layer (repo idiom:
 * `setFsImplementation` / `setOriginalFsImplementation`, see
 * purgeExit293.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  NodeFsOperations,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../fsOperations.js'
import { getSettingsFileLoadWarning } from '../settingsFileLoadWarning.js'

const TAIL =
  'so Claude Code ignores the whole file, including anything this command wrote there. Fix the file, then run this command again if its change is missing. If a newer Claude Code wrote the file, update Claude Code instead.'

const tempDirs: string[] = []

function makeConfigDirWith(settingsContent: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-dataflow004-'))
  tempDirs.push(dir)
  if (settingsContent !== null) {
    writeFileSync(join(dir, 'settings.json'), settingsContent)
  }
  // getClaudeConfigHomeDir is memoized keyed off the env var — a fresh value
  // recomputes without cache clearing (sessionEnvKeying295 idiom).
  process.env.CLAUDE_CONFIG_DIR = dir
  return dir
}

/** Make readFileSync throw `errno` for exactly `target`; everything else is real. */
function injectReadFailure(target: string, errno: string): void {
  setFsImplementation({
    ...NodeFsOperations,
    readFileSync: (path: string, options: { encoding: BufferEncoding }) => {
      if (path === target) {
        const error = new Error(
          `${errno}: permission denied, open '${path}'`,
        ) as NodeJS.ErrnoException
        error.code = errno
        throw error
      }
      return NodeFsOperations.readFileSync(path, options)
    },
  })
}

afterEach(() => {
  setOriginalFsImplementation()
  delete process.env.CLAUDE_CONFIG_DIR
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('getSettingsFileLoadWarning on an unreadable file (dataflow-004)', () => {
  test('a userSettings file that exists but cannot be read warns "it could not be read"', () => {
    // Arrange — a real file on disk (existsSync sees it) whose read fails
    // with EACCES at the fs layer, exactly like a chmod-000 file for a
    // non-root user. parseSettingsFile swallows this for non-policy sources.
    const dir = makeConfigDirWith('{"env": {"A": "b"}}')
    const filePath = join(dir, 'settings.json')
    injectReadFailure(filePath, 'EACCES')

    // Act
    const warning = getSettingsFileLoadWarning('userSettings')

    // Assert — before the fix this returned null (silent).
    expect(warning).toBe(
      `${filePath} does not load (it could not be read), ${TAIL}`,
    )
  })

  test('EPERM and other non-ENOENT read failures also warn "it could not be read"', () => {
    const dir = makeConfigDirWith('{}')
    const filePath = join(dir, 'settings.json')
    injectReadFailure(filePath, 'EPERM')

    expect(getSettingsFileLoadWarning('userSettings')).toBe(
      `${filePath} does not load (it could not be read), ${TAIL}`,
    )
  })

  test('a missing userSettings file is NOT "unreadable" (no warning)', () => {
    // Arrange — config dir exists, settings.json does not.
    makeConfigDirWith(null)

    // Act & Assert — ENOENT must not be dressed up as a load failure.
    expect(getSettingsFileLoadWarning('userSettings')).toBeNull()
  })

  test('a readable, valid file still returns null (no false positive from the probe)', () => {
    makeConfigDirWith('{"env": {"A": "b"}}')

    expect(getSettingsFileLoadWarning('userSettings')).toBeNull()
  })

  test('a readable but malformed file keeps the parse-error reason (probe does not shadow it)', () => {
    const dir = makeConfigDirWith('not json {')
    const filePath = join(dir, 'settings.json')

    // The parse path produces the blocking record; the reason stays the
    // malformed-JSON branch, not the probe's unreadable branch.
    expect(getSettingsFileLoadWarning('userSettings')).toBe(
      `${filePath} does not load (it is not a JSON object), ${TAIL}`,
    )
  })

  test('policySettings behavior does not regress (still never warned here)', () => {
    const dir = makeConfigDirWith('{}')
    injectReadFailure(join(dir, 'settings.json'), 'EACCES')

    // The official pIr early-out: the managed source is never checked by the
    // plugin-command warning path (its unreadable record lives in
    // parseSettingsFile's policySource branch, untouched by this fix).
    expect(getSettingsFileLoadWarning('policySettings')).toBeNull()
    expect(getSettingsFileLoadWarning(undefined)).toBeNull()
  })

  test('a project-scope unreadable file warns only because it exists (non-userSettings existence gate kept)', () => {
    // Arrange — projectSettings resolves under the cwd, not CLAUDE_CONFIG_DIR;
    // pointing the source at a MISSING file must skip (official eir(r)),
    // even with a read-failure injection armed for another path.
    const dir = makeConfigDirWith('{}')
    injectReadFailure(join(dir, 'settings.json'), 'EACCES')

    // userSettings warns (previous test), but a non-userSettings source whose
    // file does not exist stays silent — the existsSync gate runs BEFORE the
    // probe, so the injection can never manufacture a warning for a file that
    // was never created.
    expect(getSettingsFileLoadWarning('flagSettings')).toBeNull()
  })
})
