/**
 * CC 2.1.274 — shared helpers for the two MCP auth-stub tools (official
 * chunk `Qx(e,r)` factory: `D` authenticate + `v` complete_authentication,
 * live-binary region @211336157). Byte-verified against the 2.1.274
 * linux-x64 ELF via direct bytes extraction (NOT `strings` — the template
 * literals contain real newline bytes that strings-extraction collapses;
 * see docs/upstream-version-gap-occ128.md).
 */
import { env } from '../../utils/env.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

/** Binary `hct` — authenticate stub tool-name suffix. */
export const MCP_AUTH_TOOL_SUFFIX = 'authenticate'

/** Binary `yct` — callback-paste stub tool-name suffix. */
export const MCP_COMPLETE_AUTH_TOOL_SUFFIX = 'complete_authentication'

/**
 * Binary `R(e)` (tool-becomes-available phrase) and `T(e)` (post-auth
 * sentence). In official 2.1.274 the "callable inside the REPL environment"
 * branch is dead: `gke()` is the constant `return!1`, so `DI()` never runs
 * and both collapse to these static strings. Ported as constants — if a
 * future official release revives the branch, re-verify against the binary.
 */
export const TOOLS_BECOME_AVAILABLE_TEXT = 'available automatically'
export const TOOLS_NOW_AVAILABLE_SENTENCE =
  "The server's tools should now be available."

/**
 * Binary `I()`: `a.isSSH()||a.CLAUDE_CODE_REMOTE||Wn()`. `Wn()` (the
 * workspace-remote check) has no OCC counterpart — OCC does not ship the
 * workspace-remote subsystem (documented divergence,
 * docs/upstream-version-gap-occ128.md). Env is read at call time, matching
 * the official's module-load-time read for all practical lifecycles.
 */
export function isRemoteOAuthSession(): boolean {
  return env.isSSH() || isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
}

/**
 * Binary `z(e)`: the `redirect_uri` query param embedded in the authorize
 * URL, falling back to the generic localhost callback shape when the URL
 * does not parse or carries no redirect_uri.
 */
export function extractOAuthRedirectUri(authUrl: string): string {
  try {
    const redirectUri = new URL(authUrl).searchParams.get('redirect_uri')
    if (redirectUri) {
      return redirectUri
    }
  } catch {
    // fall through to the generic shape
  }
  return 'http://localhost:<port>/callback'
}
