import { isTransientReadFailure, type StrictReadOptions } from './transientRead.js'
import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * Creates a fallback storage that tries to use the primary storage first,
 * and if that fails, falls back to the secondary storage
 */
export function createFallbackStorage(
  primary: SecureStorage,
  secondary: SecureStorage,
): SecureStorage {
  return {
    name: `${primary.name}-with-${secondary.name}-fallback`,
    read(): SecureStorageData {
      const result = primary.read()
      if (result !== null && result !== undefined) {
        return result
      }
      return secondary.read() || {}
    },
    /**
     * Strict read (claude-code 2.1.281 #049). Delegates to the primary's strict
     * read so a TRANSIENT inaccessibility (locked macOS keychain) surfaces as the
     * {@link TRANSIENT_READ_FAILURE} sentinel instead of an empty result. The
     * sentinel is propagated WITHOUT touching the secondary: a locked primary
     * still holds a real entry, so falling back to plaintext (and later writing
     * there) would fork the credential — exactly what #049 prevents. For
     * primaries without strict support, degrades to the plain read.
     */
    readStrict(options?: StrictReadOptions): SecureStorageData {
      const primaryResult =
        typeof primary.readStrict === 'function'
          ? primary.readStrict(options)
          : primary.read()
      if (isTransientReadFailure(primaryResult)) {
        return primaryResult
      }
      if (primaryResult !== null && primaryResult !== undefined) {
        return primaryResult
      }
      return secondary.read() || {}
    },
    async readAsync(): Promise<SecureStorageData | null> {
      const result = await primary.readAsync()
      if (result !== null && result !== undefined) {
        return result
      }
      return (await secondary.readAsync()) || {}
    },
    update(data: SecureStorageData): { success: boolean; warning?: string } {
      // Capture state before update
      const primaryDataBefore = primary.read()

      const result = primary.update(data)

      if (result.success) {
        // Delete secondary when migrating to primary for the first time
        // This preserves credentials when sharing .claude between host and containers
        // See: https://github.com/anthropics/claude-code/issues/1414
        if (primaryDataBefore === null) {
          secondary.delete()
        }
        return result
      }

      const fallbackResult = secondary.update(data)

      if (fallbackResult.success) {
        // Primary write failed but primary may still hold an *older* valid
        // entry. read() prefers primary whenever it returns non-null, so that
        // stale entry would shadow the fresh data we just wrote to secondary —
        // e.g. a refresh token the server has already rotated away, causing a
        // /login loop (#30337). Best-effort delete; if this also fails the
        // user's keychain is in a bad state we can't fix from here.
        if (primaryDataBefore !== null) {
          primary.delete()
        }
        return {
          success: true,
          warning: fallbackResult.warning,
        }
      }

      return { success: false }
    },
    delete(): boolean {
      const primarySuccess = primary.delete()
      const secondarySuccess = secondary.delete()

      return primarySuccess || secondarySuccess
    },
  }
}
