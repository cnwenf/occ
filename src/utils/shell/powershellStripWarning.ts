import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'

/**
 * Verbatim official v287 startup warning (binary @213518738), with the official
 * tool display names substituted.
 *
 * Recovered template literal:
 *   `Denying ${Ue} also turns off the ${St} tool, so Claude has neither. To use ${St}, set CLAUDE_CODE_USE_POWERSHELL_TOOL=1.`
 * where `Ue` = Bash and `St` = PowerShell (gap-research-287 cluster-e Item 10).
 * BashTool.userFacingName() === 'Bash' and PowerShellTool.userFacingName() ===
 * 'PowerShell', which equal BASH_TOOL_NAME / POWERSHELL_TOOL_NAME, so the
 * interpolated result is byte-identical to the official:
 *   "Denying Bash also turns off the PowerShell tool, so Claude has neither. To use PowerShell, set CLAUDE_CODE_USE_POWERSHELL_TOOL=1."
 */
export const POWERSHELL_STRIP_WARNING = `Denying ${BASH_TOOL_NAME} also turns off the ${POWERSHELL_TOOL_NAME} tool, so Claude has neither. To use ${POWERSHELL_TOOL_NAME}, set CLAUDE_CODE_USE_POWERSHELL_TOOL=1.`

/**
 * The official's five "PowerShell is enabled/allowed" checks (binary `ye`).
 * If ANY is true the PowerShell tool is left alone — no strip, no warning:
 *
 *   ye = a.CLAUDE_CODE_USE_POWERSHELL_TOOL        // 1. env var
 *     || Op(s ?? []).map(Ql).includes(St)          // 2. allowlist (--tools)
 *     || S.some((r) => jn(r).toolName === St)      // 3. rule source S (--allowedTools)
 *     || q.some((r) => r.toolName === St)          // 4. rule source q (--disallowedTools)
 *     || B.some((r) => r.ruleValue.toolName === St)// 5. rule source B (settings/disk rules)
 */
export interface PowerShellEnabledFacts {
  /** check 1 — env var `CLAUDE_CODE_USE_POWERSHELL_TOOL`. OCC: isPowerShellToolEnabled(). */
  envEnabled: boolean
  /** check 2 — allowlist: the `--tools` base list names PowerShell. */
  inAllowlist: boolean
  /** check 3 — rule source S: CLI `--allowedTools` names PowerShell. */
  namedByAllowedCli: boolean
  /** check 4 — rule source q: CLI `--disallowedTools` names PowerShell. */
  namedByDisallowedCli: boolean
  /** check 5 — rule source B: a settings/disk permission rule names PowerShell. */
  namedByDiskRules: boolean
}

/**
 * Bash-deny facts. `cliDisallowNamesBash` / `diskDenyNamesBash` feed the strip
 * gate `Pe`; `cliDisallowBlanketBash` / `diskDenyBashFromPolicy` feed the
 * warning gate.
 *
 * STAGED — bash-family predicate `ne`: official v287 broadened the bash-deny
 * predicate from v286's `r.toolName === Bash` to a bash-FAMILY predicate `ne`
 * (`fe = q.some(ne)`, `r = B.filter((p) => p.ruleBehavior === "deny" && ne(p.ruleValue))`).
 * The BODY of `ne` was NOT recovered in gap-research-287 cluster-e Item 10, so
 * per the "never invent predicate bodies" rule OCC keeps the v286 Bash-toolName
 * -only shape. When `ne` is recovered, widen the four `*Bash*` computations at
 * the call site (permissionSetup.ts) — this interface needs no change.
 */
export interface BashDenyFacts {
  /** Pe term 1 — `q.some((r) => r.toolName === Bash)`: CLI `--disallowedTools` names Bash. */
  cliDisallowNamesBash: boolean
  /** Pe term 2 / `r.length > 0` — a disk deny rule names Bash. */
  diskDenyNamesBash: boolean
  /** warning `fe` (v286 shape) — CLI `--disallowedTools` has a BLANKET Bash entry (no ruleContent). */
  cliDisallowBlanketBash: boolean
  /** warning policy exclusion — `r.some((p) => p.source === "policySettings")`: a Bash deny rule is managed-policy sourced. */
  diskDenyBashFromPolicy: boolean
}

export interface PowerShellStripDecisionInput {
  /** official `O()` — process platform. Only `'windows'` triggers the gate. */
  platform: string
  /** official `Fa()` — Git Bash was not found. */
  gitBashMissing: boolean
  /** official `vb()` — interactive startup (the warning is interactive-only). */
  interactive: boolean
  bashDeny: BashDenyFacts
  powershellEnabled: PowerShellEnabledFacts
}

export interface PowerShellStripDecision {
  /** official `v = [...v, St]` — add PowerShell to the tools-to-disallow set. */
  disallowPowerShell: boolean
  /** official `h.push(...)` — the verbatim startup warning (interactive-only). */
  warning?: string
}

/**
 * Pure port of the official v287 Bash-deny → PowerShell-strip decision
 * (binary @213518738). Verbatim recovered shape:
 *
 *   if (O() === "windows" && Fa() && Pe && !ye) {
 *     v = [...v, St];                                          // strip
 *     let r = B.filter((p) => p.ruleBehavior === "deny" && ne(p.ruleValue));
 *     if (vb() && (fe || r.length > 0) && !r.some((p) => p.source === "policySettings"))
 *       h.push(`Denying ${Ue} also turns off the ${St} tool, ...`);  // warn
 *   }
 *
 * Pe = Bash denied, ye = PowerShell enabled (five checks), fe = blanket Bash in
 * CLI disallow, r = bash-family deny rules. `ne` (bash-family) is STAGED to the
 * v286 Bash-toolName shape — see BashDenyFacts. Kept side-effect-free so the
 * Windows-only runtime gate is fully unit-testable on linux CI.
 */
export function decidePowerShellStrip(
  input: PowerShellStripDecisionInput,
): PowerShellStripDecision {
  const {
    platform,
    gitBashMissing,
    interactive,
    bashDeny,
    powershellEnabled,
  } = input

  // Pe — Bash is disallowed (CLI --disallowedTools OR a disk deny rule).
  const bashDenied =
    bashDeny.cliDisallowNamesBash || bashDeny.diskDenyNamesBash

  // ye — PowerShell is enabled/allowed by ANY of the five official checks.
  const powershellEnabledAny =
    powershellEnabled.envEnabled ||
    powershellEnabled.inAllowlist ||
    powershellEnabled.namedByAllowedCli ||
    powershellEnabled.namedByDisallowedCli ||
    powershellEnabled.namedByDiskRules

  // Outer gate: windows && gitBashMissing && Pe && !ye.
  if (
    platform !== 'windows' ||
    !gitBashMissing ||
    !bashDenied ||
    powershellEnabledAny
  ) {
    return { disallowPowerShell: false }
  }

  // v = [...v, St] — strip PowerShell whenever the outer gate passes.
  const decision: PowerShellStripDecision = { disallowPowerShell: true }

  // Warning gate: vb() && (fe || r.length > 0) && !r.some(source === policySettings).
  // r.length > 0 ≡ diskDenyNamesBash (r = disk deny rules naming Bash; family STAGED).
  const warnBashDenied =
    bashDeny.cliDisallowBlanketBash || bashDeny.diskDenyNamesBash
  if (interactive && warnBashDenied && !bashDeny.diskDenyBashFromPolicy) {
    decision.warning = POWERSHELL_STRIP_WARNING
  }

  return decision
}
