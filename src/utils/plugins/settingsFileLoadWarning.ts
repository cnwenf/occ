/**
 * Settings-file load check after a plugin CLI command (CC 2.1.295 port).
 *
 * Changelog (2.1.295): "`claude plugin install/enable/disable/marketplace add`
 * now warn when the settings file they just wrote does not load" (a malformed
 * or unreadable settings JSON is ignored WHOLE-FILE by Claude Code, so the
 * command's write silently has no effect).
 *
 * Verbatim port of the official checker `pIr` (@s295): after the command's
 * write succeeded, re-parse the source's settings file; when a blocking
 * (non-warning) record exists for that file, return the official sentence:
 *
 *   `<file> does not load (<reason>), so Claude Code ignores the whole file,
 *   including anything this command wrote there. Fix the file, then run this
 *   command again if its change is missing. If a newer Claude Code wrote the
 *   file, update Claude Code instead.`
 *
 * `<reason>` branches (official): a schema-invalid value →
 * `its "<path≤80>" is not valid` (or `its "<path≤80>" and N other values are
 * not valid`); an OS-level read failure → `it could not be read`; a non-object
 * / malformed JSON document → `it is not a JSON object`.
 *
 * Deviations (documented): the official path-display helper `qs(r)` is
 * unrecoverable from the minified binary — the resolved file path is printed
 * as-is; the official truncation `je(path, 80)` maps to `sliceHead(path, 80)`.
 * The check never throws into the command: any internal failure is logged
 * with the official skip message and returns null.
 */
import { existsSync } from 'fs'
import { basename } from 'path'
import figures from 'figures'
import type { SettingSource } from '../settings/constants.js'
import {
  getSettingsFilePathForSource,
  parseSettingsFile,
} from '../settings/settings.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { plural } from '../stringUtils.js'
import { sliceHead } from '../truncateMiddle.js'

/** Official `je(f.path, 80)` — the invalid-value path is capped at 80 chars. */
const PATH_DISPLAY_CAP = 80

/**
 * Build the official warning for a settings source whose file does not load,
 * or null when the file loads fine / the source is not checkable.
 *
 * Mirrors official `pIr(e)` early-outs: no source and the managed source are
 * never warned about; a cowork-mode userSettings file (`cowork_settings.json`)
 * is skipped; for non-userSettings sources a file that does not exist has
 * nothing to load and is skipped.
 */
export function getSettingsFileLoadWarning(
  source: SettingSource | undefined,
): string | null {
  try {
    if (source === undefined || source === 'policySettings') {
      return null
    }
    const filePath = getSettingsFilePathForSource(source)
    if (filePath === undefined) {
      return null
    }
    // Official: `n==="userSettings" && ye(r)===aC.cowork` → skip.
    if (
      source === 'userSettings' &&
      basename(filePath) === 'cowork_settings.json'
    ) {
      return null
    }
    // Official `eir(r)` for non-userSettings sources: a settings file that
    // was never created cannot be broken — nothing to warn about.
    if (source !== 'userSettings' && !existsSync(filePath)) {
      return null
    }
    // Fresh read: updateSettingsForSource resets the settings caches after a
    // write, so this parse sees the file as it is on disk NOW.
    const { errors } = parseSettingsFile(filePath)
    const blocking = errors.filter(
      record => record.file === filePath && record.severity !== 'warning',
    )
    const [first] = blocking
    if (first === undefined) {
      return null
    }
    const otherCount = blocking.length - 1
    const reason =
      first.path !== ''
        ? `its "${sliceHead(first.path, PATH_DISPLAY_CAP)}" ${
            otherCount > 0
              ? `and ${otherCount} other ${plural(otherCount, 'value')} are`
              : 'is'
          } not valid`
        : first.errorClass === 'unreadable'
          ? 'it could not be read'
          : 'it is not a JSON object'
    return `${filePath} does not load (${reason}), so Claude Code ignores the whole file, including anything this command wrote there. Fix the file, then run this command again if its change is missing. If a newer Claude Code wrote the file, update Claude Code instead.`
  } catch (error) {
    // Official catch arm, verbatim message.
    logForDebugging(
      `settings file check after a plugin command skipped: ${errorMessage(error)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * Print the official `⚠ <file> does not load (...)` line when the settings
 * file a plugin command just wrote to does not load. Non-fatal: the command's
 * own success output and exit code are untouched.
 */
export function warnIfSettingsFileDoesNotLoad(
  source: SettingSource | undefined,
): void {
  const warning = getSettingsFileLoadWarning(source)
  if (warning !== null) {
    // Official printer fragment: `${te.warning} ${r}`.
    // biome-ignore lint/suspicious/noConsole:: intentional CLI output
    console.log(`${figures.warning} ${warning}`)
  }
}
