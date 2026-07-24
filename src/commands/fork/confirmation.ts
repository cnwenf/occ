import { CLI_BINARY_NAME } from '../../constants/cli.js'

/**
 * 2.1.216 #30 — `/fork` one-line confirmation.
 *
 * The 2.1.212 in-session row was `Forked session <id> (fork)`, which named
 * only the bare session id and gave no attach hint or checkout note. #30
 * improves the confirmation to a single line carrying three pieces:
 *
 *   1. the new session's name (derived from the directive via `deriveForkName`,
 *      the official `uwd`);
 *   2. the `occ attach` id (the forked session's id, so the user can
 *      re-open / join the copy);
 *   3. a note when the copy shares your checkout.
 *
 * Pure decision logic — the visual render (the REPL system row) is the
 * OCC-11 e2e surface.
 */

/**
 * Format the `/fork` confirmation as a single line.
 *
 * @param forkName The derived fork session name (official `uwd`).
 * @param sessionId The forked session's id — the value `occ attach` takes.
 * @param sharesCheckout `true` when the fork runs in the parent's git
 *   checkout (no separate worktree). OCC's `/fork` does not spin up a
 *   separate worktree for the copy (the live background-session dispatch is
 *   deferred — see CHANGELOG / `docs/upstream-version-gap-occ9.md`), so the
 *   copy shares the parent's checkout and this is `true` at the call site.
 */
export function formatForkConfirmation(
  forkName: string,
  sessionId: string,
  sharesCheckout: boolean,
): string {
  const base = `Forked session ${forkName} (${CLI_BINARY_NAME} attach ${sessionId})`
  return sharesCheckout ? `${base} (shares your checkout)` : base
}
