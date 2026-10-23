/**
 * CC 2.1.309 (WP-D / changelog item 14) — effective input-mode resolution for
 * composer submits + the auto mode-restore guard.
 *
 * Key-bound slash commands no longer run in the shell when triggered from `!`
 * (bash) mode: the keybinding loop submits with
 * `{fromKeybinding:true, inputModeOverride:"prompt"}` (official BIN309
 * @274974889) and the composer computes the effective submit mode from that
 * override instead of the live mode.
 *
 * Official BIN309 symbol map (composer onSubmit, minified):
 * - `ao=D?.inputModeOverride??st.mode` (@276384951 region)
 *   → resolveEffectiveInputMode. `ao` feeds the history display prefix
 *   (`{display:SPe(h,ao)}` @276385717), the bash ghost-text gate
 *   (`ao==="bash"`), the submit call (`{inputMode:ao,...}` @276388745) and the
 *   handlePromptSubmit analog (`mode:ao` @276389479).
 * - `tn=D?.inputModeOverride!==void 0&&(D.fromKeybinding===!0||D.keepsComposer===!0)`
 *   + `if(Yo&&!tn)st.setMode("prompt")` (@276387905 region)
 *   → shouldSkipAutoPromptRestore. `Yo` is the OCC `submitsNow` analog.
 *   308→309 delta: 308 skipped the restore whenever ANY override was present
 *   (`L?.inputModeOverride===void 0`, BIN308 @275369500 region); 309 skips
 *   only when the override came from a keybinding or keepsComposer.
 *
 * STRUCTURAL DEVIATION (declared): the official computes `ao`/`tn` inline in
 * the minified composer; OCC extracts them into this pure module following the
 * repo convention (promptSuppression.ts, resumeFailureGate.ts) so the REPL
 * wiring stays thin and the semantics are unit-testable. `keepsComposer` has
 * no OCC producer yet — the clause is kept byte-faithful and dormant.
 */
import type { PromptInputMode } from '../types/textInputTypes.js';

/** Submit options that can redirect the effective input mode. */
export type SubmitModeOptions = {
  fromKeybinding?: boolean;
  inputModeOverride?: 'prompt';
  keepsComposer?: boolean;
};

/**
 * Official `ao=D?.inputModeOverride??st.mode`: the mode a submit is processed
 * as, regardless of the composer's live mode.
 */
export function resolveEffectiveInputMode(
  inputMode: PromptInputMode,
  options: SubmitModeOptions | undefined
): PromptInputMode {
  return options?.inputModeOverride ?? inputMode;
}

/**
 * Official `tn`: when true, the post-submit auto restore to 'prompt' mode is
 * SKIPPED (`if(Yo&&!tn)st.setMode("prompt")`) so a key-bound command fired
 * from `!` mode leaves the composer in `!` mode afterwards.
 */
export function shouldSkipAutoPromptRestore(
  options: SubmitModeOptions | undefined
): boolean {
  return (
    options?.inputModeOverride !== undefined &&
    (options?.fromKeybinding === true || options?.keepsComposer === true)
  );
}
