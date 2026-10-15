/**
 * CC 2.1.299 #025 — teammate task-description credential retention.
 *
 * A teammate spawned WITHOUT an explicit `description` used to keep a raw
 * 50-char prompt fragment in the derived task description (stored via
 * createTaskStateBase, rendered in the progress line / task output / peer list,
 * and emitted to hooks as `task_description`). Official 2.1.299 replaced the
 * inline `${prompt.substring(0,50)}…` at BOTH spawn sites with `GQn(prompt)`:
 *
 *   var S=50; function GQn(o){let s=R$t(o,S),e=ne(s,S);return e.length<s.length?`${e}...`:e}
 *
 * `R$t` ≡ redactSecretsWithCap (engine `mZn`) and `ne` ≡ truncateUtf16Prefix
 * (textSlicing `re`) — both already ported. `describeTeammatePrompt` is the
 * faithful composition (redact-then-truncate).
 *
 * Expected strings below are machine-captured from the real helper output under
 * Bun (not hand-typed): see the assertions' grounded values.
 */
import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../../tasks/InProcessTeammateTask/types.js'
import { describeTeammatePrompt } from '../describeTeammate.js'
import { spawnInProcessTeammate } from '../spawnInProcess.js'

// --- Fixtures (secrets the redaction engine detects) ------------------------

const SK_ANT_PROMPT =
  'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 please review the auth module'
const AWS_PROMPT =
  'AKIAIOSFODNN7EXAMPLE is the access key id for the deploy pipeline'
const BEARER_PROMPT =
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N check this'
const WHOLE_SECRET_PROMPT =
  'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const STRADDLE_PROMPT =
  'Review this code and also note the key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ok'
const CLEAN_SHORT = 'Summarize the auth module and list its exports' // 46 chars
const CLEAN_LONG =
  'Please refactor the authentication module to use dependency injection and add unit tests for every exported helper function' // 123 chars

describe('describeTeammatePrompt (official 2.1.299 GQn) — secret redaction', () => {
  test('redacts an sk-ant API key in the first 50 chars', () => {
    const out = describeTeammatePrompt(SK_ANT_PROMPT)
    expect(out).toBe('[REDACTED] please review the auth module')
    expect(out).not.toContain('sk-ant')
    expect(out).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
  })

  test('redacts an AWS access key id in the first 50 chars', () => {
    const out = describeTeammatePrompt(AWS_PROMPT)
    expect(out).toBe('[REDACTED] is the access key id for the deploy pip...')
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  test('redacts a bearer JWT in the first 50 chars', () => {
    const out = describeTeammatePrompt(BEARER_PROMPT)
    expect(out).toBe('Bearer [REDACTED] check this')
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
  })

  test('whole-prompt secret collapses to the marker', () => {
    const out = describeTeammatePrompt(WHOLE_SECRET_PROMPT)
    expect(out).toBe('[REDACTED]')
    expect(out).not.toContain('sk-ant')
  })

  test('redact-then-truncate catches a secret straddling the 50-char boundary', () => {
    // Truncating first would leave a partial `sk-ant-api0…` that no rule matches;
    // redacting the FULL prompt first collapses it to [REDACTED] before the cut.
    const out = describeTeammatePrompt(STRADDLE_PROMPT)
    expect(out).toBe('Review this code and also note the key [REDACTED] ...')
    expect(out).not.toContain('sk-ant')
    expect(out).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
  })
})

describe('describeTeammatePrompt — clean-prompt regression (unchanged vs old substring)', () => {
  test('clean prompt under 50 chars is returned verbatim, no ellipsis', () => {
    const out = describeTeammatePrompt(CLEAN_SHORT)
    expect(out).toBe(CLEAN_SHORT)
    expect(out).toBe('Summarize the auth module and list its exports')
    expect(out.endsWith('...')).toBe(false)
  })

  test('clean prompt over 50 chars matches the old substring(0,50)+"..." behavior', () => {
    const out = describeTeammatePrompt(CLEAN_LONG)
    const legacy = `${CLEAN_LONG.substring(0, 50)}${CLEAN_LONG.length > 50 ? '...' : ''}`
    expect(out).toBe(legacy)
    expect(out).toBe('Please refactor the authentication module to use d...')
  })

  test('empty prompt yields empty description slice', () => {
    expect(describeTeammatePrompt('')).toBe('')
  })

  test('exactly 50 chars: no ellipsis; 51 chars: ellipsis', () => {
    const exact50 = 'a'.repeat(50)
    const exact51 = 'a'.repeat(51)
    expect(describeTeammatePrompt(exact50)).toBe(exact50)
    expect(describeTeammatePrompt(exact51)).toBe(`${'a'.repeat(50)}...`)
  })

  test('never splits a surrogate pair at the boundary (improvement over substring)', () => {
    // 49 ASCII + a 2-code-unit emoji straddling the 50 boundary.
    const prompt = `${'a'.repeat(49)}\u{1F600}tail`
    const out = describeTeammatePrompt(prompt)
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    expect(loneSurrogate.test(out)).toBe(false)
  })
})

describe('spawnInProcessTeammate — derived task description carries no secret (#025)', () => {
  // Capture the task state handed to AppState by registerTask's setAppState.
  function capturingSetAppState() {
    let registered: InProcessTeammateTaskState | undefined
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      const next = updater({ tasks: {} } as unknown as AppState)
      const ids = Object.keys(next.tasks ?? {})
      if (ids.length > 0) {
        registered = next.tasks[ids[0]] as InProcessTeammateTaskState
      }
    }
    return { setAppState, getRegistered: () => registered }
  }

  test('secret-bearing prompt → stored description is redacted, prompt intact', async () => {
    const { setAppState, getRegistered } = capturingSetAppState()
    const result = await spawnInProcessTeammate(
      {
        name: 'reviewer',
        teamName: 'team-a',
        prompt: SK_ANT_PROMPT,
        planModeRequired: false,
      },
      { setAppState },
    )

    expect(result.success).toBe(true)
    const task = getRegistered()
    expect(task).toBeDefined()
    // Description = `${name}: ${describeTeammatePrompt(prompt)}` — no secret.
    expect(task?.description).toBe(
      'reviewer: [REDACTED] please review the auth module',
    )
    expect(task?.description).not.toContain('sk-ant')
    // The raw prompt is still the teammate's actual input (not the description).
    expect(task?.prompt).toBe(SK_ANT_PROMPT)
  })

  test('clean prompt → stored description unchanged (regression)', async () => {
    const { setAppState, getRegistered } = capturingSetAppState()
    const result = await spawnInProcessTeammate(
      {
        name: 'summarizer',
        teamName: 'team-b',
        prompt: CLEAN_SHORT,
        planModeRequired: false,
      },
      { setAppState },
    )

    expect(result.success).toBe(true)
    expect(getRegistered()?.description).toBe(
      `summarizer: ${CLEAN_SHORT}`,
    )
  })
})
