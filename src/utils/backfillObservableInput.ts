import { logForDebugging } from './debug.js'
import { logError } from './log.js'
import { isNullBytePathError } from './path.js'

/**
 * CC 2.1.281 changelog #040 (security) — guarded backfillObservableInput.
 *
 * Byte-verified against the official v2.1.281 linux-x64 ELF `cl()` @208557126:
 *
 *   ...backfillObservableInput(r),
 *      Object.keys(r).some((g)=>!(g in n))?r:null
 *   }catch(s){
 *     if(s instanceof lae)
 *       return t(`${e.name}: backfillObservableInput met a path expandPath
 *         refuses (null byte); passing the tool input on as the model sent
 *         it`),null;
 *     return u(ot(se(s),"backfillObservableInput threw")),null}
 *
 * Two guarantees, both new in v281 (v280 called backfill unguarded, so a
 * `\0` in a model-sent path made `expandPath` throw and killed the turn):
 * 1. A null-byte path the backfill's `expandPath` refuses is logged (debug
 *    line containing "backfillObservableInput met a path") and the tool input
 *    passes through exactly as the model sent it — validateInput then reports
 *    the per-call null-byte error instead of the turn crashing.
 * 2. ANY other throw from a tool's backfillObservableInput is logged and
 *    swallowed (fail-safe: backfill is observable-input decoration, never a
 *    turn-fatal operation).
 *
 * Return contract (unchanged from the pre-existing query.ts inline logic):
 * the backfilled copy ONLY when fields were ADDED; null when nothing was
 * added or when the backfill threw — overwriting existing fields would change
 * the serialized transcript and break VCR fixture hashes on resume.
 */
export interface BackfillObservableTool {
  name: string
  backfillObservableInput?: (input: Record<string, unknown>) => void
}

export function backfillObservableInputSafely(
  tool: BackfillObservableTool,
  originalInput: Record<string, unknown>,
): Record<string, unknown> | null {
  const inputCopy = { ...originalInput }
  try {
    tool.backfillObservableInput?.(inputCopy)
    return Object.keys(inputCopy).some(key => !(key in originalInput))
      ? inputCopy
      : null
  } catch (error) {
    if (isNullBytePathError(error)) {
      logForDebugging(
        `${tool.name}: backfillObservableInput met a path expandPath refuses (null byte); passing the tool input on as the model sent it`,
      )
    } else {
      logError(error)
      logForDebugging(`${tool.name}: backfillObservableInput threw`)
    }
    return null
  }
}
