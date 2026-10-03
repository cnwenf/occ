import { describe, expect, test } from 'bun:test'
import {
  type BashDenyFacts,
  decidePowerShellStrip,
  type PowerShellEnabledFacts,
  type PowerShellStripDecisionInput,
  POWERSHELL_STRIP_WARNING,
} from '../powershellStripWarning.js'

// All-false baselines so each test flips exactly the facts under investigation.
const NO_BASH_DENY: BashDenyFacts = {
  cliDisallowNamesBash: false,
  diskDenyNamesBash: false,
  cliDisallowBlanketBash: false,
  diskDenyBashFromPolicy: false,
}
const NO_POWERSHELL: PowerShellEnabledFacts = {
  envEnabled: false,
  inAllowlist: false,
  namedByAllowedCli: false,
  namedByDisallowedCli: false,
  namedByDiskRules: false,
}

function input(
  overrides: Partial<PowerShellStripDecisionInput> & {
    bashDeny?: Partial<BashDenyFacts>
    powershellEnabled?: Partial<PowerShellEnabledFacts>
  } = {},
): PowerShellStripDecisionInput {
  const { bashDeny, powershellEnabled, ...rest } = overrides
  return {
    platform: 'windows',
    gitBashMissing: true,
    interactive: true,
    bashDeny: { ...NO_BASH_DENY, ...bashDeny },
    powershellEnabled: { ...NO_POWERSHELL, ...powershellEnabled },
    ...rest,
  }
}

describe('POWERSHELL_STRIP_WARNING string', () => {
  test('is byte-exact to the official v287 warning (display names substituted)', () => {
    expect(POWERSHELL_STRIP_WARNING).toBe(
      'Denying Bash also turns off the PowerShell tool, so Claude has neither. To use PowerShell, set CLAUDE_CODE_USE_POWERSHELL_TOOL=1.',
    )
  })
})

describe('decidePowerShellStrip — outer strip gate (windows && gitBashMissing && Pe && !ye)', () => {
  test('does not strip on a non-windows platform', () => {
    const decision = decidePowerShellStrip(
      input({ platform: 'darwin', bashDeny: { cliDisallowBlanketBash: true, cliDisallowNamesBash: true } }),
    )
    expect(decision.disallowPowerShell).toBe(false)
    expect(decision.warning).toBeUndefined()
  })

  test('does not strip when git bash is present (gitBashMissing=false)', () => {
    const decision = decidePowerShellStrip(
      input({ gitBashMissing: false, bashDeny: { cliDisallowBlanketBash: true, cliDisallowNamesBash: true } }),
    )
    expect(decision.disallowPowerShell).toBe(false)
    expect(decision.warning).toBeUndefined()
  })

  test('does not strip when Bash is not denied', () => {
    const decision = decidePowerShellStrip(input({ bashDeny: { ...NO_BASH_DENY } }))
    expect(decision.disallowPowerShell).toBe(false)
    expect(decision.warning).toBeUndefined()
  })

  test('strips when Bash is denied via CLI --disallowedTools', () => {
    const decision = decidePowerShellStrip(
      input({ bashDeny: { cliDisallowNamesBash: true, cliDisallowBlanketBash: true } }),
    )
    expect(decision.disallowPowerShell).toBe(true)
  })

  test('strips when Bash is denied via a disk deny rule', () => {
    const decision = decidePowerShellStrip(
      input({ bashDeny: { diskDenyNamesBash: true } }),
    )
    expect(decision.disallowPowerShell).toBe(true)
  })
})

describe('decidePowerShellStrip — the five PowerShell-enabled checks each veto the strip', () => {
  const bashDenied = { cliDisallowNamesBash: true, cliDisallowBlanketBash: true }

  test('check 1: env var enabled → no strip', () => {
    const decision = decidePowerShellStrip(
      input({ bashDeny: bashDenied, powershellEnabled: { envEnabled: true } }),
    )
    expect(decision.disallowPowerShell).toBe(false)
  })

  test('check 2: allowlist names PowerShell → no strip', () => {
    const decision = decidePowerShellStrip(
      input({ bashDeny: bashDenied, powershellEnabled: { inAllowlist: true } }),
    )
    expect(decision.disallowPowerShell).toBe(false)
  })

  test('check 3: --allowedTools names PowerShell → no strip', () => {
    const decision = decidePowerShellStrip(
      input({ bashDeny: bashDenied, powershellEnabled: { namedByAllowedCli: true } }),
    )
    expect(decision.disallowPowerShell).toBe(false)
  })

  test('check 4: --disallowedTools names PowerShell → no strip', () => {
    const decision = decidePowerShellStrip(
      input({ bashDeny: bashDenied, powershellEnabled: { namedByDisallowedCli: true } }),
    )
    expect(decision.disallowPowerShell).toBe(false)
  })

  test('check 5: a disk rule names PowerShell → no strip', () => {
    const decision = decidePowerShellStrip(
      input({ bashDeny: bashDenied, powershellEnabled: { namedByDiskRules: true } }),
    )
    expect(decision.disallowPowerShell).toBe(false)
  })
})

describe('decidePowerShellStrip — warning gate (vb() && (fe || r.length>0) && !policySettings)', () => {
  test('warns on interactive startup with a blanket Bash CLI disallow (fe)', () => {
    const decision = decidePowerShellStrip(
      input({ bashDeny: { cliDisallowNamesBash: true, cliDisallowBlanketBash: true } }),
    )
    expect(decision.disallowPowerShell).toBe(true)
    expect(decision.warning).toBe(POWERSHELL_STRIP_WARNING)
  })

  test('warns on interactive startup with a disk Bash deny rule (r.length>0)', () => {
    const decision = decidePowerShellStrip(
      input({ bashDeny: { diskDenyNamesBash: true } }),
    )
    expect(decision.disallowPowerShell).toBe(true)
    expect(decision.warning).toBe(POWERSHELL_STRIP_WARNING)
  })

  test('strips but does NOT warn when startup is non-interactive (vb() gate)', () => {
    const decision = decidePowerShellStrip(
      input({ interactive: false, bashDeny: { diskDenyNamesBash: true } }),
    )
    expect(decision.disallowPowerShell).toBe(true)
    expect(decision.warning).toBeUndefined()
  })

  test('strips but does NOT warn when the Bash deny rule is sourced from policySettings', () => {
    const decision = decidePowerShellStrip(
      input({
        bashDeny: { diskDenyNamesBash: true, diskDenyBashFromPolicy: true },
      }),
    )
    expect(decision.disallowPowerShell).toBe(true)
    expect(decision.warning).toBeUndefined()
  })

  test('strips but does NOT warn for a content-scoped CLI Bash disallow (fe is blanket-only, family STAGED)', () => {
    // q.some(toolName===Bash) is true (strip via Pe) but the v286 `fe` shape
    // requires ruleContent===undefined; a scoped Bash(cmd) disallow is not blanket
    // and there is no disk deny rule, so (fe || r.length>0) is false → no warning.
    const decision = decidePowerShellStrip(
      input({
        bashDeny: { cliDisallowNamesBash: true, cliDisallowBlanketBash: false },
      }),
    )
    expect(decision.disallowPowerShell).toBe(true)
    expect(decision.warning).toBeUndefined()
  })

  test('policySettings exclusion only suppresses the warning, not the strip, when a CLI blanket deny also exists', () => {
    const decision = decidePowerShellStrip(
      input({
        bashDeny: {
          cliDisallowNamesBash: true,
          cliDisallowBlanketBash: true,
          diskDenyNamesBash: true,
          diskDenyBashFromPolicy: true,
        },
      }),
    )
    // r.some(source===policySettings) is true → warning suppressed regardless of fe.
    expect(decision.disallowPowerShell).toBe(true)
    expect(decision.warning).toBeUndefined()
  })
})
