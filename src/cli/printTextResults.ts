/**
 * CC 2.1.295 changelog #017 — "Fixed `claude -p` text output dropping earlier
 * responses when background work started another turn; each turn's response
 * now prints when the turn ends."
 *
 * Ported byte-faithfully from the official v295 compiled bundle
 * (/tmp/cc-153/v295/package/claude, module @ offset 241184987):
 *
 *   class hg{limits;lastPrinted=void 0;printedCount=0;endsWithNewline=!0;
 *     constructor(e){this.limits=e}
 *     printAtTurnEnd(e,n){try{if(k("tengu_jazzy_puddle",!0)&&!vT(e,n))
 *       this.print(e,n)}catch(r){c(r),m("print_text_results","print_failed")}}
 *     printAtExit(e,n){if(e!==this.lastPrinted&&(this.printedCount===0||
 *       !vT(e,n)))this.print(e,n);if(this.printedCount>1)
 *       g("print_text_results",{results_printed:this.printedCount})}
 *     print(e,n){let r;switch(e.subtype){case"success":{let h=n===void 0?
 *       e.result:`${n}\n${e.result}`;r=h.endsWith("\n")?h:h+"\n";break}
 *       case"error_during_execution":{let h=BGn();if(h!==void 0)
 *       process.stderr.write(`${h}\n`);r="Execution error";break}
 *       case"error_max_turns":r=`Error: Reached max turns
 *       (${this.limits.maxTurns})`;break;case"error_max_budget_usd":
 *       r=`Error: Exceeded USD budget (${this.limits.maxBudgetUsd})`;break;
 *       case"error_max_structured_output_retries":r=`Error: ${e.errors[0]??
 *       "Failed to provide valid structured output after maximum retries"}`}
 *       let s=this.printedCount===0?"":this.endsWithNewline?"\n":"\n\n";
 *       Ar(s+r),this.lastPrinted=e,this.printedCount++,
 *       this.endsWithNewline=r.endsWith("\n")}}
 *   function vT(e,n){return e.subtype==="success"&&n===void 0&&
 *     e.result.trim()===""}
 *
 * Class `hg` @ v295 offset ~241577450–241578923 (`tengu_jazzy_puddle` string
 * @ 241578223, `print_text_results` @ 241578290/241578445). Absent from v294
 * (printAtTurnEnd / printAtExit / print_text_results / tengu_jazzy_puddle /
 * lateReleasedResults all have zero hits in the v294 binary); v294 printed the
 * final result once via an inline subtype switch @ ~238822933 — the exact code
 * OCC's print.ts `default:` case carried before this port.
 *
 * Helper mapping (documented per official-symbol precedent in this repo):
 * - `Ar` → writeToStdout (src/utils/process.js)
 * - `k`  → getFeatureValue_CACHED_MAY_BE_STALE (feature flag, default true)
 * - `g`  → logEvent (positive telemetry)
 * - `m(event, detail)` → logEvent(event, { stage: detail }) — mapping
 *   precedent: src/cli/handlers/ultrareview.ts
 * - `c` (captureError) → no OCC surface (precedent comment:
 *   src/bridge/initReplBridge.ts "Official also does captureError(err)")
 * - `BGn()` (autoModeUnavailableStopNotice stderr latch) — identical in
 *   v294↔v295 (thus NOT part of the #017 delta) and unported in OCC; the
 *   stderr write is omitted (no-op), see error_during_execution below.
 */
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { logEvent } from 'src/services/analytics/index.js'
import { writeToStdout } from 'src/utils/process.js'

/** Official v295: `Ma=new hg({maxTurns:R.maxTurns,maxBudgetUsd:R.maxBudgetUsd})`. */
export interface PrintTextResultsLimits {
  maxTurns: number | undefined
  maxBudgetUsd: number | undefined
}

/**
 * Loose structural view of an SDK result message (SDKResultMessage union in
 * official: subtype 'success' carries `result: string`; the four error
 * subtypes carry `errors: string[]`). Kept index-signature-compatible with
 * OCC's SDKMessage so call sites can pass messages with a plain cast.
 */
export interface PrintableResultMessage {
  type: string
  subtype?: string
  result?: string
  errors?: string[]
  [key: string]: unknown
}

/**
 * Official v295 `vT` (@ ~241578830): true when a success result carries no
 * text and there is no partial prefix — such a result is skipped at turn end
 * (and at exit unless nothing was printed yet).
 */
export function isEmptySuccessResult(
  message: PrintableResultMessage,
  partialForResult: string | undefined,
): boolean {
  return (
    message.subtype === 'success' &&
    partialForResult === undefined &&
    (message.result ?? '').trim() === ''
  )
}

/**
 * Official v295 `hg` — prints each turn's text result when the turn ends
 * (printAtTurnEnd, gated by tengu_jazzy_puddle) and dedupes the final result
 * at exit (printAtExit, identity check against lastPrinted). Replaces the
 * v294 behavior of printing only the last result at exit, which dropped
 * earlier turns' responses when background work started another turn.
 */
export class PrintTextResults {
  limits: PrintTextResultsLimits
  lastPrinted: PrintableResultMessage | undefined = undefined
  printedCount = 0
  endsWithNewline = true

  constructor(limits: PrintTextResultsLimits) {
    this.limits = limits
  }

  /** Official: `printAtTurnEnd(e,n)` — v295 offset ~241577620. */
  printAtTurnEnd(
    message: PrintableResultMessage,
    partialForResult: string | undefined,
  ): void {
    try {
      if (
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_jazzy_puddle', true) &&
        !isEmptySuccessResult(message, partialForResult)
      ) {
        this.print(message, partialForResult)
      }
    } catch {
      // Official also does captureError(err) — no OCC surface.
      logEvent('print_text_results', { stage: 'print_failed' })
    }
  }

  /** Official: `printAtExit(e,n)` — v295 offset ~241577830. */
  printAtExit(
    message: PrintableResultMessage,
    partialForResult: string | undefined,
  ): void {
    if (
      message !== this.lastPrinted &&
      (this.printedCount === 0 ||
        !isEmptySuccessResult(message, partialForResult))
    ) {
      this.print(message, partialForResult)
    }
    if (this.printedCount > 1) {
      logEvent('print_text_results', { results_printed: this.printedCount })
    }
  }

  /** Official: `print(e,n)` — v295 offset ~241578000. */
  print(
    message: PrintableResultMessage,
    partialForResult: string | undefined,
  ): void {
    let text: string
    switch (message.subtype) {
      case 'success': {
        // Official: `n===void 0?e.result:`${n}\n${e.result}``. OCC callers
        // currently always pass undefined: the partialForResult tracker
        // (`Bi`/`kT`/`wT`) is byte-identical in v294↔v295 (tracker @ v294
        // ~238747449) — a pre-existing separate gap, not part of #017.
        const result = message.result ?? ''
        const joined =
          partialForResult === undefined
            ? result
            : `${partialForResult}\n${result}`
        text = joined.endsWith('\n') ? joined : joined + '\n'
        break
      }
      case 'error_during_execution': {
        // Official v295 first writes the BGn() autoModeUnavailableStopNotice
        // latch to stderr when set; that latch is identical in v294↔v295 and
        // unported in OCC — omitted (no-op).
        text = 'Execution error'
        break
      }
      case 'error_max_turns':
        text = `Error: Reached max turns (${this.limits.maxTurns})`
        break
      case 'error_max_budget_usd':
        text = `Error: Exceeded USD budget (${this.limits.maxBudgetUsd})`
        break
      case 'error_max_structured_output_retries':
        // Official v295 added the `e.errors[0]??` prefix over v294's fixed
        // string (v294 @ ~238822933 had no errors[0] branch).
        text = `Error: ${
          message.errors?.[0] ??
          'Failed to provide valid structured output after maximum retries'
        }`
        break
      default:
        // Schema-unreachable: the SDK result subtype union is exhaustive
        // above; official's compiled switch has no default. Print nothing
        // rather than corrupt stdout.
        return
    }
    const separator =
      this.printedCount === 0 ? '' : this.endsWithNewline ? '\n' : '\n\n'
    writeToStdout(separator + text)
    this.lastPrinted = message
    this.printedCount++
    this.endsWithNewline = text.endsWith('\n')
  }
}
