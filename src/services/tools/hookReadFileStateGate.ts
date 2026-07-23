// CC 2.1.216 #6 (a): @-mentions silently attach NOTHING after
// file-modifying hooks.
//
// When a PreToolUse hook runs an external script that modifies a file, the
// `readFileState` cache is never invalidated. If the file's mtime happens
// to match the cached timestamp (common with coarse filesystem mtime
// resolution — 1s on many FSes — or when the hook re-touches within the
// same tick), `generateFileAttachment` returns `already_read_file`, which
// `normalizeAttachmentForAPI` drops to `[]` → the model sees nothing.
//
// The fix: after PreToolUse hooks run, invalidate `readFileState` so the
// next @-mention forces a fresh read. This is conservative (may re-read
// files unnecessarily) but prevents the silent-empty-attachment bug.
//
// Extracted as a pure helper so the invalidation decision is unit-testable.

/**
 * Whether `readFileState` should be invalidated after PreToolUse hooks run.
 *
 * @param hooksRan  True when at least one PreToolUse hook executed.
 */
export function shouldInvalidateReadFileStateAfterHooks(
  hooksRan: boolean,
): boolean {
  // Any PreToolUse hook can modify files externally. Invalidate the cache
  // to force re-reading on the next @-mention attachment.
  return hooksRan
}
