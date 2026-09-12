/**
 * CC 2.1.268 E26: @ file and / command suggestions reappear after recalling a
 * previous prompt with the up arrow and EDITING it.
 *
 * Official mechanism (byte-verified from the 2.1.267/2.1.268 binaries):
 *
 *   - The history hook (2.1.268 `dLe`, 2.1.267 `SOe` — identical in both)
 *     tracks the last value set by history navigation in a ref (`no=A(null)`,
 *     written in the input setter `no.current=Cn,P(Cn,…)` and cleared in
 *     resetHistory `no.current=null`) and returns
 *       `historyEdited:xe>0&&we!==no.current`
 *     where `xe` is the historyIndex state and `we` the current input value.
 *
 *   - The suggestions consumer changed its suppression gate — this is the
 *     actual 267→268 delta:
 *       2.1.267: `const Jvt=Xm||rLe>0;`        → `suppressSuggestions:Jvt`
 *       2.1.268: `const Rwt=ip||$Le>0&&!WLe;`  → `suppressSuggestions:Rwt`
 *     i.e. `isSearchingHistory || (historyIndex > 0 && !historyEdited)`.
 *     While the recalled prompt is unedited suggestions stay suppressed; as
 *     soon as the user edits it, `historyEdited` flips true and the @ file /
 *     / command suggestions reappear.
 */

/** Official `historyEdited:xe>0&&we!==no.current`. */
export function computeHistoryEdited(
  historyIndex: number,
  currentInput: string,
  recalledValue: string | null,
): boolean {
  return historyIndex > 0 && currentInput !== recalledValue
}

/** Official 2.1.268 gate `ip||$Le>0&&!WLe` (suppressSuggestions). */
export function computeSuppressSuggestions(
  isSearchingHistory: boolean,
  historyIndex: number,
  historyEdited: boolean,
): boolean {
  return isSearchingHistory || (historyIndex > 0 && !historyEdited)
}
