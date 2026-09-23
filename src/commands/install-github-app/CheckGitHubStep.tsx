import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Box, Text } from '../../ink.js';
export function CheckGitHubStep() {
  const $ = _c(1);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // CC 2.1.280 (#066): the GitHub CLI check step now shows "Esc to cancel".
    // Official v280 @226720089: `r(s,{flexDirection:"column",gap:1,paddingX:2,
    // children:[m,e(n,{dimColor:!0,children:e(Xe,{action:"confirm:no",
    // context:"Settings",fallback:"Esc",description:"cancel"})})]})` where m is
    // the "Checking GitHub CLI installation…" message; v278 @226930814 was a
    // bare `e(s,{paddingX:2,children:e(lr,{message:...})})` with no hint.
    t0 = <Box flexDirection="column" gap={1} paddingX={2}><Text>Checking GitHub CLI installation…</Text><Text dimColor={true}><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" /></Text></Box>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  return t0;
}
