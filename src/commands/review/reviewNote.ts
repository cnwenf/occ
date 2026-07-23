/**
 * CC 2.1.218 #8 — `/ultrareview` descriptive arguments.
 *
 * Descriptive free-text args (e.g. "review my auth changes") no longer fail;
 * they run a branch review with the text applied as a note to the findings.
 * The only OCC-controlled channel to pass a note into the cloud bughunter is
 * the `BUGHUNTER_*` environment-variable surface (the same surface already
 * used for `BUGHUNTER_BASE_BRANCH`), so the note rides on
 * `BUGHUNTER_REVIEW_NOTE`. Cloud-side consumption of the note is out of
 * scope (the bughunter runs in CCR — see OCC-19 gap report §5, #9 ⛔ cloud).
 */

const PR_NUMBER_RE = /^\d+$/

/**
 * Build the review-note env-var overlay for a given `/ultrareview` argument.
 *
 * Returns `{ BUGHUNTER_REVIEW_NOTE: args }` when `args` is non-empty AND not a
 * pure PR number (i.e. descriptive free text). Returns `{}` otherwise so PR
 * mode and empty-arg invocations are unchanged.
 */
export function reviewNoteEnv(args: string): Record<string, string> {
  const trimmed = args.trim()
  if (trimmed === '' || PR_NUMBER_RE.test(trimmed)) {
    return {}
  }
  return { BUGHUNTER_REVIEW_NOTE: trimmed }
}
