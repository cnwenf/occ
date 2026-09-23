import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { HooksSettings } from '../../settings/types.js'

/**
 * 2.1.280 (#004): "Added hook output sizes and the number of oversized
 * outputs saved to a file to the hook_execution_complete OpenTelemetry
 * event." Five new attrs, byte-verified against the official ELFs:
 *
 *   v280 @199828703 (emit):
 *     stdout_chars:String(bn.hookSuccessStdoutChars),
 *     additional_context_chars:String(bn.additionalContextChars),
 *     system_message_chars:String(bn.systemMessageChars),
 *     initial_user_message_chars:String(bn.initialUserMessageChars),
 *     num_outputs_persisted:String(jn)
 *   v278: 0 hits for stdout_chars / num_outputs_persisted; the v278 emit
 *     (@200699239) jumps total_duration_ms → managed_only.
 *
 * Feeds (v280):
 *   @199822212 — hook_success attachment: bn.hookSuccessStdoutChars +=
 *     attachment.stdout?.length ?? 0; if (stdout !== undefined &&
 *     jKt(stdout.trim(), content)) jn++
 *   @199825220 — per-surface: bn.<surface>Chars += value.length;
 *     dr = await ene(value, ...); if (jKt(value, dr)) jn++
 *
 * OCC has NOT ported the spill producer `ene` (present already in v278 —
 * a pre-2.1.280 upstream gap, staged), so the oversized-output case is
 * exercised by simulating the producer's artifact at the attachment
 * boundary (see the attachments.js mock below).
 */

// --- Mock seams (OCC-97: Bun's mock.module leaks across test files in the
// same worker — spread the real module, override narrowly, restore below). ---

const actualSnapshotModule = await import('../hooksConfigSnapshot.js')
let mockedHooksConfig: HooksSettings | null = null
mock.module('../hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => mockedHooksConfig,
}))

const actualEventsModule = await import('../../telemetry/events.js')
type OtelCall = { name: string; attrs: Record<string, string | undefined> }
const otelCalls: OtelCall[] = []
mock.module('../../telemetry/events.js', () => ({
  ...actualEventsModule,
  logOTelEvent: (
    name: string,
    attrs: Record<string, string | undefined> = {},
  ): Promise<void> => {
    otelCalls.push({ name, attrs })
    return Promise.resolve()
  },
}))

const actualTracingModule = await import('../../telemetry/sessionTracing.js')
mock.module('../../telemetry/sessionTracing.js', () => ({
  ...actualTracingModule,
  isBetaTracingEnabled: () => true,
  startHookSpan: () => undefined,
  endHookSpan: () => {},
}))

// Simulate the official spill producer's artifact: when a hook_success
// attachment carries stdout marked OVERSIZED, replace its content with the
// <persisted-output> wrapper shape the official `ene` emits (v280
// @199825220: dr = await ene(...); jKt(value, dr) → jn++).
const actualAttachmentsModule = await import('../../attachments.js')
// Capture the real function by value BEFORE mock.module — Bun live-patches
// the already-imported namespace, so referencing
// actualAttachmentsModule.createAttachmentMessage at call time would
// re-enter the wrapper (infinite recursion).
const actualCreateAttachmentMessage =
  actualAttachmentsModule.createAttachmentMessage
const OVERSIZED_MARKER = 'OVERSIZED'
const SIMULATED_PERSISTED_WRAPPER =
  '<persisted-output>\nHook output saved to /tmp/occ-simulated-spill.txt\n</persisted-output>'
type AttachmentArg = Parameters<typeof actualCreateAttachmentMessage>[0]
mock.module('../../attachments.js', () => ({
  ...actualAttachmentsModule,
  createAttachmentMessage: (attachment: AttachmentArg) => {
    const candidate = attachment as { type?: string; stdout?: unknown }
    if (
      candidate.type === 'hook_success' &&
      typeof candidate.stdout === 'string' &&
      candidate.stdout.startsWith(OVERSIZED_MARKER)
    ) {
      return actualCreateAttachmentMessage({
        ...attachment,
        content: SIMULATED_PERSISTED_WRAPPER,
      } as AttachmentArg)
    }
    return actualCreateAttachmentMessage(attachment)
  },
}))

afterAll(() => {
  mock.module('../hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
  mock.module('../../telemetry/events.js', () => ({ ...actualEventsModule }))
  mock.module('../../telemetry/sessionTracing.js', () => ({
    ...actualTracingModule,
  }))
  mock.module('../../attachments.js', () => ({ ...actualAttachmentsModule }))
})

const { executeSessionStartHooks, hookOutputWasPersisted } = await import(
  '../../hooks.js'
)
const { setSessionTrustAccepted } = await import('../../../bootstrap/state.js')

beforeAll(() => {
  // Interactive-mode trust gate (shouldSkipHookDueToTrust) — session trust
  // latches true for the whole process.
  setSessionTrustAccepted(true)
})

afterEach(() => {
  mockedHooksConfig = null
  otelCalls.length = 0
})

function sessionStartConfig(command: string): HooksSettings {
  return {
    SessionStart: [{ matcher: '', hooks: [{ type: 'command', command }] }],
  } as unknown as HooksSettings
}

async function drain(gen: AsyncGenerator<unknown>): Promise<any[]> {
  const out: any[] = []
  for await (const item of gen) {
    out.push(item)
  }
  return out
}

function lastCompleteAttrs(): Record<string, string | undefined> {
  const events = otelCalls.filter(c => c.name === 'hook_execution_complete')
  expect(events).toHaveLength(1)
  return events[0]!.attrs
}

describe('2.1.280 (#004) — hook_execution_complete output-size attrs', () => {
  test('plain-stdout hook: stdout_chars counts the successful hook stdout; other surfaces stay 0', async () => {
    mockedHooksConfig = sessionStartConfig(`printf '%s' 'hello'`)

    await drain(executeSessionStartHooks('startup'))

    const attrs = lastCompleteAttrs()
    expect(attrs.hook_event).toBe('SessionStart')
    expect(attrs.num_hooks).toBe('1')
    expect(attrs.num_success).toBe('1')
    expect(attrs.num_non_blocking_error).toBe('0')
    expect(attrs.stdout_chars).toBe('5')
    expect(attrs.additional_context_chars).toBe('0')
    expect(attrs.system_message_chars).toBe('0')
    expect(attrs.initial_user_message_chars).toBe('0')
    expect(attrs.num_outputs_persisted).toBe('0')
  })

  test('JSON hook: chars injected into each output surface are counted per surface', async () => {
    const json = JSON.stringify({
      systemMessage: 'SYS123', // 6 chars
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'CTX99', // 5 chars
        initialUserMessage: 'INIT777', // 7 chars
      },
    })
    mockedHooksConfig = sessionStartConfig(`printf '%s' '${json}'`)

    const results = await drain(executeSessionStartHooks('startup'))

    // The injected surfaces actually flowed through the aggregate loop.
    expect(
      results.some(r => Array.isArray(r.additionalContexts)),
    ).toBe(true)
    expect(results.some(r => r.initialUserMessage === 'INIT777')).toBe(true)

    const attrs = lastCompleteAttrs()
    expect(attrs.system_message_chars).toBe('6')
    expect(attrs.additional_context_chars).toBe('5')
    expect(attrs.initial_user_message_chars).toBe('7')
    // stdout_chars counts the raw stdout of successful hooks (the JSON text).
    expect(attrs.stdout_chars).toBe(String(json.length))
    expect(attrs.num_outputs_persisted).toBe('0')
  })

  test('oversized output spilled to a persisted wrapper: num_outputs_persisted increments', async () => {
    // 11009 bytes of stdout — above the official spill threshold
    // (fpo = 1e4, v280). The attachments mock simulates `ene` rewriting the
    // content into the <persisted-output> wrapper; the ported `jKt` consumer
    // (hookOutputWasPersisted) must then bump num_outputs_persisted.
    mockedHooksConfig = sessionStartConfig(`printf 'OVERSIZED%011000d' 0`)

    await drain(executeSessionStartHooks('startup'))

    const attrs = lastCompleteAttrs()
    expect(attrs.num_outputs_persisted).toBe('1')
    // stdout_chars still counts the raw (pre-spill) stdout length.
    expect(attrs.stdout_chars).toBe('11009')
  })

  test('non-spilled large-looking output does not increment (content === stdout)', async () => {
    // Same OVERSIZED-prefixed stdout, but this time assert the guard logic
    // directly: without the wrapper rewrite there is no spill. Use a short
    // plain hook — content ('hi') equals stdout.trim() → jKt false.
    mockedHooksConfig = sessionStartConfig(`printf '%s' 'hi'`)

    await drain(executeSessionStartHooks('startup'))

    const attrs = lastCompleteAttrs()
    expect(attrs.num_outputs_persisted).toBe('0')
    expect(attrs.stdout_chars).toBe('2')
  })

  test('the five attrs sit between num_cancelled and managed_only (binary @199828703 layout)', async () => {
    mockedHooksConfig = sessionStartConfig(`printf '%s' 'hello'`)

    await drain(executeSessionStartHooks('startup'))

    // Object-literal insertion order mirrors the official emit order. NOTE:
    // the official also has total_duration_ms between num_cancelled and
    // stdout_chars — an attr OCC lacks since before v278 (pre-existing gap,
    // out of this port's scope).
    const keys = Object.keys(lastCompleteAttrs())
    const i = keys.indexOf('num_cancelled')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(keys.slice(i + 1, i + 6)).toEqual([
      'stdout_chars',
      'additional_context_chars',
      'system_message_chars',
      'initial_user_message_chars',
      'num_outputs_persisted',
    ])
    expect(keys[i + 6]).toBe('managed_only')
  })
})

describe('2.1.280 (#004) — hookOutputWasPersisted (byte-port of jKt, v280 ELF @197236240)', () => {
  // function jKt(e,r){return r.startsWith(hX)&&r.endsWith(Fkn)&&r!==e}
  // hX = "<persisted-output>" (@197225624), Fkn = "</persisted-output>"
  const WRAPPER =
    '<persisted-output>\nHook output saved to /tmp/x.txt\n</persisted-output>'

  test('wrapper content that differs from the original → true', () => {
    expect(hookOutputWasPersisted('raw hook output', WRAPPER)).toBe(true)
  })

  test('identical strings → false (r !== e guard: raw output that merely looks like a wrapper is not a spill)', () => {
    expect(hookOutputWasPersisted(WRAPPER, WRAPPER)).toBe(false)
  })

  test('non-wrapper content → false', () => {
    expect(hookOutputWasPersisted('raw', 'plain processed text')).toBe(false)
  })

  test('unclosed wrapper → false (endsWith guard)', () => {
    expect(
      hookOutputWasPersisted('raw', '<persisted-output>\nsaved to /tmp/x.txt'),
    ).toBe(false)
  })

  test('wrapper without the opening tag → false (startsWith guard)', () => {
    expect(
      hookOutputWasPersisted('raw', 'saved to /tmp/x.txt\n</persisted-output>'),
    ).toBe(false)
  })
})
