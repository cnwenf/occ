import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Text } from '../ink.js';

/**
 * Official `Ia()` @227383175 (v2.1.288 linux-x64 ELF) — verbatim:
 *   `function Ia(){return"What should Claude do instead?"}`
 */
export function interruptedHintText(): string {
  return "What should Claude do instead?";
}

/**
 * CC 2.1.288 #59 — official `var Lt=Wt(!1)` @227383175, i.e. `createContext(false)`.
 *
 * The message row supplies the value from `message.interruptedBySendNow === true`:
 *   - `case "user"` @227595016: `const Te=l.interruptedBySendNow===!0;`
 *     `… e(Lt.Provider,{value:Te,children:qe})`
 *   - `case "collapsed_read_search"` @227597624: `Te` is derived from the
 *     group's tool results —
 *     `lookups.toolResultByToolUseID.get(uuid)?.type==="user" && …interruptedBySendNow===!0`
 *
 * The flag itself is stamped by `stampSendNowCut` (src/utils/sendNowCut.ts,
 * official `_stampSendNowCut` @229515877).
 */
export const InterruptedBySendNowContext = React.createContext(false);

/**
 * Official `La()` @227383175 — verbatim structure:
 *   `function La(){let l=w(3);`
 *   `  if(Ce(Lt)){ … e(n,{dimColor:!0,children:"Interrupted"}) … return p}`   // no hint
 *   `  … e(n,{dimColor:!0,children:"Interrupted "}) …`
 *   `  r(K,{children:[p, r(n,{dimColor:!0,children:["\xB7 ",Ia()]})]}) …}`    // hint
 *
 * Two shapes: the send-now cut renders bare `Interrupted` (no trailing space),
 * the user Esc interrupt renders `Interrupted ` + `· What should Claude do
 * instead?`.
 */
export function InterruptedByUser() {
  const $ = _c(3);
  const isBySendNow = React.useContext(InterruptedBySendNowContext);
  if (isBySendNow) {
    let t0;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t0 = <Text dimColor={true}>Interrupted</Text>;
      $[0] = t0;
    } else {
      t0 = $[0];
    }
    return t0;
  }
  let t0;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = <Text dimColor={true}>Interrupted </Text>;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  let t1;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <>{t0}<Text dimColor={true}>{`· ${interruptedHintText()}`}</Text></>;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  return t1;
}
