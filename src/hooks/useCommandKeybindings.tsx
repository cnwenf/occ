import { c as _c } from "react/compiler-runtime";
/**
 * Component that registers keybinding handlers for command bindings.
 *
 * Must be rendered inside KeybindingSetup to have access to the keybinding context.
 * Reads "command:*" actions from the current keybinding configuration and registers
 * handlers that invoke the corresponding slash command via onSubmit.
 *
 * Commands triggered via keybinding are treated as "immediate" - they execute right
 * away and preserve the user's existing input text (the prompt is not cleared).
 *
 * 2.1.309 alignment (item 14): official BIN309 @274974889 loop component `OG`
 * (308: `_G` @273947007) submits with `{fromKeybinding:!0,inputModeOverride:"prompt"}`
 * — OCC symbol map: official `x` (composer onSubmit) → this file's `onSubmit`
 * prop; official `ct` → `commandName`. The override makes the REPL compute the
 * effective submit mode (`ao=D?.inputModeOverride??st.mode`, BIN309 @276384951)
 * as 'prompt' so a key-bound slash command triggered from `!` (bash) mode no
 * longer runs in the shell.
 */
import { useMemo } from 'react';
import { useIsModalOverlayActive } from '../context/overlayContext.js';
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import type { PromptInputHelpers } from '../utils/handlePromptSubmit.js';
type Props = {
  // onSubmit accepts additional parameters beyond what we pass here,
  // so we use a rest parameter to allow any additional args
  onSubmit: (input: string, helpers: PromptInputHelpers, ...rest: [speculationAccept?: undefined, options?: {
    fromKeybinding?: boolean;
    /**
     * 2.1.309 (item 14): forces the composer to treat this submit as the given
     * input mode regardless of the live mode, so a key-bound slash command
     * triggered from `!` (bash) mode routes as a prompt command, not the shell.
     * Official BIN309 @274974889:
     *   `Ge[st]=()=>{x(\`/${ct}\`,Wm,{fromKeybinding:!0,inputModeOverride:"prompt"})}`
     */
    inputModeOverride?: 'prompt';
  }]) => void;
  /** Set to false to disable command keybindings (e.g., when a dialog is open) */
  isActive?: boolean;
};
const NOOP_HELPERS: PromptInputHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {}
};

/**
 * Registers keybinding handlers for all "command:*" actions found in the
 * user's keybinding configuration. When triggered, each handler submits
 * the corresponding slash command (e.g., "command:commit" submits "/commit").
 */
export function CommandKeybindingHandlers(t0) {
  const $ = _c(8);
  const {
    onSubmit,
    isActive: t1
  } = t0;
  const isActive = t1 === undefined ? true : t1;
  const keybindingContext = useOptionalKeybindingContext();
  const isModalOverlayActive = useIsModalOverlayActive();
  let t2;
  bb0: {
    if (!keybindingContext) {
      let t3;
      if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
        t3 = new Set();
        $[0] = t3;
      } else {
        t3 = $[0];
      }
      t2 = t3;
      break bb0;
    }
    let actions;
    if ($[1] !== keybindingContext.bindings) {
      actions = new Set();
      for (const binding of keybindingContext.bindings) {
        if (binding.action?.startsWith("command:")) {
          actions.add(binding.action);
        }
      }
      $[1] = keybindingContext.bindings;
      $[2] = actions;
    } else {
      actions = $[2];
    }
    t2 = actions;
  }
  const commandActions = t2;
  let map;
  if ($[3] !== commandActions || $[4] !== onSubmit) {
    map = {};
    for (const action of commandActions) {
      const commandName = action.slice(8);
      map[action] = () => {
        // 2.1.309 (item 14): official BIN309 @274974889 adds
        // `inputModeOverride:"prompt"` so key-bound slash commands never run
        // in the shell when the composer is in `!` (bash) mode.
        onSubmit(`/${commandName}`, NOOP_HELPERS, undefined, {
          fromKeybinding: true,
          inputModeOverride: 'prompt'
        });
      };
    }
    $[3] = commandActions;
    $[4] = onSubmit;
    $[5] = map;
  } else {
    map = $[5];
  }
  const handlers = map;
  const t3 = isActive && !isModalOverlayActive;
  let t4;
  if ($[6] !== t3) {
    t4 = {
      context: "Chat",
      isActive: t3
    };
    $[6] = t3;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  useKeybindings(handlers, t4);
  return null;
}
