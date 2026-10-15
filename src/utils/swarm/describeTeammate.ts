/**
 * Teammate task-description derivation (prompt → display slice).
 *
 * Faithful port of the official Claude Code 2.1.299 `GQn(prompt)` helper. The
 * 296→299 delta replaced the inline derived description at BOTH teammate-spawn
 * sites with `GQn`:
 *
 *   v296 (leaks):  description = `${name}: ${prompt.substring(0,50)}${prompt.length>50?"...":""}`
 *   v299 (fixed):  let M = o.description || GQn(prompt)   // spawnInProcessTeammate
 *                  let u = A          || GQn(prompt)      // pane/tmux `te()`
 *
 * `GQn` recovered byte-for-byte from the 2.1.299 linux-x64 ELF (@31792111):
 *
 *   var S=50;
 *   function GQn(o){let s=R$t(o,S),e=ne(s,S);return e.length<s.length?`${e}...`:e}
 *
 * where both callees were verified identical to OCC's already-ported engine
 * internals (so this helper just composes two existing exports):
 *   R$t ≡ redactSecretsWithCap (engine `mZn`, @34252545) — capped secret
 *        redaction; every detected credential becomes the `[REDACTED]` marker.
 *   ne  ≡ truncateUtf16Prefix (textSlicing `re`, @14022xxx) — slice a prefix of
 *        at most n UTF-16 code units, never splitting a surrogate pair.
 *
 * Behavior: REDACT the full prompt first (so a credential anywhere collapses to
 * `[REDACTED]` and can never survive truncation as a partial secret), THEN
 * truncate the redacted text to 50 code units, appending "..." only when the
 * truncation actually shortened it. This closes the 2.1.299 teammate
 * task-description credential-retention gap: a teammate spawned WITHOUT an
 * explicit `description` no longer keeps a raw prompt fragment (potential
 * `sk-ant-…` / AWS key / bearer token) in the description that is stored in
 * task state (createTaskStateBase), rendered in the progress line / task output
 * / peer list, and emitted to hooks as `task_description`.
 *
 * The explicit-description path is intentionally NOT touched: official uses the
 * caller-supplied description raw (`o.description || GQn(…)`, `A || GQn(…)`),
 * so an explicit `input.description` flows through unchanged.
 */
import {
  redactSecretsWithCap,
  truncateUtf16Prefix,
} from '../secretRedaction/index.js'

/** Official `S=50` — the derived-description budget (UTF-16 code units). */
const DESCRIPTION_BUDGET = 50

/**
 * Derive the prompt-slice of a teammate's task description.
 *
 * Port of official 2.1.299 `GQn`. Returns the redact-then-truncate summary of
 * the prompt (no name prefix); callers keep OCC's `${name}: <summary>` display
 * convention. Never contains a detected secret.
 */
export function describeTeammatePrompt(prompt: string): string {
  const redacted = redactSecretsWithCap(prompt, DESCRIPTION_BUDGET)
  const truncated = truncateUtf16Prefix(redacted, DESCRIPTION_BUDGET)
  return truncated.length < redacted.length ? `${truncated}...` : truncated
}
