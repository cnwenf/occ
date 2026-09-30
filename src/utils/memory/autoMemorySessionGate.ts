/**
 * Auto-memory background/tool-started session gate — CC 2.1.285.
 *
 * Official changelog: "Changed /memory so that Auto-memory can no longer be
 * turned on from a background session or from a session one of Claude Code's
 * own tools started; turning it off there still works."
 *
 * Byte-faithful port of the official v2.1.285 detection (decompiled ELF):
 *
 *   function RUe(){                                    // "tool-started / child session"
 *     if(a.CLAUDE_CODE_CHILD_SESSION)return!0;
 *     if(!a.CLAUDECODE)return!1;
 *     return a.CLAUDE_CODE_SKIP_PROMPT_HISTORY||!process.stdin.isTTY&&!process.stdout.isTTY
 *   }
 *   function fw(){return n().host.extensionsConfig.teammateAgentId()}
 *   function EAe(){                                    // "raise allowed"
 *     return!(a.CLAUDE_CODE_SESSION_KIND!==void 0||fw()!==void 0)&&!RUe()
 *   }
 *   function RPe(){return EAe()}                       // raiseAllowed alias
 *   var OVt="can't be turned on here; use a session started outside Claude Code"
 *
 * (`a` = process.env.) The toggle handlers gate ON only:
 *   `function ht(h){ ...; if(h&&!RPe())return; ...persist autoMemoryEnabled... }`
 *   `function Mt(h){ ...; if(h&&!RPe())return; ...persist autoDreamEnabled... }`
 * so turning the setting OFF (`h` falsy) always proceeds.
 *
 * OCC mapping (no invention — same env vars / same semantics):
 *   - `CLAUDE_CODE_SESSION_KIND` — read by OCC already (src/utils/concurrentSessions.ts
 *     mirrors the official `fQe()`); the OCC daemon/backend convention marks a
 *     background session with this var.
 *   - `fw()!==void 0` (teammateAgentId defined) → OCC `isTeammate()`.
 *   - `CLAUDECODE` — OCC sets `CLAUDECODE=1` for processes its own tools start
 *     (src/utils/Shell.ts, src/services/mcp/client.ts) and for swarm teammates
 *     (src/utils/swarm/spawnUtils.ts), which is exactly the "session one of
 *     Claude Code's own tools started" case.
 *   - `CLAUDE_CODE_CHILD_SESSION` — OCC never sets it; the read is kept for
 *     byte-fidelity and simply falls through (always falsy here).
 *   - `CLAUDE_CODE_SKIP_PROMPT_HISTORY` / `process.stdin.isTTY` /
 *     `process.stdout.isTTY` — read verbatim.
 */
import { isTeammate } from '../teammate.js'

/**
 * Official `OVt` — the row detail shown when auto-memory is off and cannot be
 * raised from this session kind. Byte-exact.
 */
export const AUTO_MEMORY_RAISE_DENIED_DETAIL =
  "can't be turned on here; use a session started outside Claude Code"

/**
 * Official `RUe()` — true when this session was started by one of Claude Code's
 * own tools (a child/tool-spawned session), so persistent settings must not be
 * raised from it. Byte-faithful: `CLAUDE_CODE_SKIP_PROMPT_HISTORY` is used as a
 * raw truthy string (any non-empty value counts), matching the official
 * `a.CLAUDE_CODE_SKIP_PROMPT_HISTORY||...` short-circuit — NOT the stricter
 * isEnvTruthy parser.
 */
export function isToolStartedSession(): boolean {
  if (process.env.CLAUDE_CODE_CHILD_SESSION) return true
  if (!process.env.CLAUDECODE) return false
  return (
    Boolean(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY) ||
    (!process.stdin.isTTY && !process.stdout.isTTY)
  )
}

/**
 * Official `EAe()` / `RPe()` (raiseAllowed) — true when auto-memory (and
 * auto-dream) may be turned ON from this session. False for background
 * sessions (`CLAUDE_CODE_SESSION_KIND` set), teammates, and tool-started
 * sessions (`RUe`). Turning the setting OFF is never gated.
 */
export function isAutoMemoryRaiseAllowed(): boolean {
  return (
    !(process.env.CLAUDE_CODE_SESSION_KIND !== undefined || isTeammate()) &&
    !isToolStartedSession()
  )
}
