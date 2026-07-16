/**
 * Pure guard logic for --forward-subagent-text validation.
 *
 * Extracted from main.tsx so it can be unit-tested without spawning the
 * full CLI. The guard mirrors the upstream binary:
 *   if(pe){if(!St||L!=="stream-json"){if(k)return ls("Error: ...");pe=!1}}
 * Only errors when the CLI flag `k` is explicitly set; env-only silently disables.
 */

export const FORWARD_SUBAGENT_TEXT_ERROR =
  'Error: --forward-subagent-text requires --print and --output-format=stream-json.';

/**
 * Evaluate the --forward-subagent-text guard.
 *
 * @param effective  - true if CLI flag OR env var is set
 * @param isNonInteractiveSession - true when -p/--print mode is active
 * @param outputFormat - the output format ('text' | 'json' | 'stream-json' | undefined)
 * @param cliFlag - true if the CLI flag (not env var) was explicitly set
 * @returns the error message string if the guard should fire, or null if no error
 */
export function checkForwardSubagentTextGuard(
  effective: boolean,
  isNonInteractiveSession: boolean,
  outputFormat: string | undefined,
  cliFlag: boolean,
): string | null {
  if (effective) {
    if (!isNonInteractiveSession || outputFormat !== 'stream-json') {
      if (cliFlag) {
        return FORWARD_SUBAGENT_TEXT_ERROR;
      }
      // Env-only: silently disable (matches upstream behavior)
    }
  }
  return null;
}
