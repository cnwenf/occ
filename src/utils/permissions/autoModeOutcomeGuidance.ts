/**
 * CC 2.1.281 #109: outcome-scope guidance for auto-mode denials.
 *
 * Official binary evidence (v2.1.281 linux-x64 ELF, byte-verified; zero-hit
 * proof on v2.1.280 for "This denial applies to the outcome"):
 *   - `mnn` / `gnn` / `lKe` @200520366: the three constants below, exactly as
 *     the binary concatenates them (`lKe = ${mnn} ${gnn} ` + batch sentence +
 *     clear-it sentence).
 *   - Injection point `hxn` @204144495 (OCC counterpart:
 *     `buildYoloRejectionMessage` in src/utils/messages.ts):
 *     `${prefix}${reason}. If you have other tasks … ${stopSuffix} ${lKe}`
 *     followed by the optional permission-rule hint. `hxn` embeds `lKe`
 *     UNCONDITIONALLY — both of its call sites (`S0t` @203102301 and the
 *     classifier block path @224914260) invoke it with no cadence gate.
 *     (The `cKe=120000` constant @200521365 and the duration formatter `t4`
 *     belong to `b6t` @204147071 — the auto-mode classifier API-wait message
 *     builder, where `k4o=cKe` is the "You cannot wait this out inside the
 *     turn" threshold — NOT to this guidance's injection cadence. The
 *     triage-B "once-per-2-min-window" reading is disproved by the binary.)
 *   - `gnn`'s tool-name template slots were resolved byte-exactly from the
 *     binary (never guessed):
 *       `${lt}` = "Read" — `var lt="Read"` @195486034 with
 *         `export{lt,xRr,_sn}` (chunk-2fedg631.js), imported by the
 *         mnn-module @200436982.
 *       `${zr}` = "Grep" — `var oo="Glob";var zr="Grep"` @195865320;
 *         chunk-5khn4tvf.js's export list @196104434 contains both `zr` and
 *         `oo`, and the mnn-module imports `{…,oo,zr,…}` from that chunk
 *         @200414860.
 */

/** Official `mnn` @200520366 — verbatim. */
export const OUTCOME_SCOPE_DENIAL_GUIDANCE =
  "This denial applies to the outcome, not only this exact command: don't pursue the same outcome through another tool, interpreter, host, encoding, sub-agent or later turn, and don't record ways around it."

/**
 * Official `gnn` @200520588 — verbatim, with `${lt}`→Read and `${zr}`→Grep
 * byte-resolved from the binary (see module header).
 */
export const OUTCOME_SCOPE_PURSUIT_EXAMPLES =
  'Concretely, these all count as pursuing the same outcome: running the same command in smaller pieces; leaving the flagged part out of this call and covering it in another; reading the same file or data with a different tool (Read, Grep, head, awk, a script); re-issuing it with different quoting, flags, paths or hosts.'

/** Official `lKe` @200520908 — the full concatenation, verbatim. */
export const AUTO_MODE_OUTCOME_SCOPE_GUIDANCE =
  `${OUTCOME_SCOPE_DENIAL_GUIDANCE} ${OUTCOME_SCOPE_PURSUIT_EXAMPLES} ` +
  'If this was a batch or range operation, you may re-run it without the flagged items, but do not then act on the flagged items separately — leave those for the user. ' +
  'If this denial names something that would clear it — for example a first-hand read that shows the missing source — doing that is not pursuing the denied outcome: do it, and if it shows what the denial asked for, you may redo the action citing it.'
