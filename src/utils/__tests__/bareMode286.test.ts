import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isBareFilteredAttachment } from '../attachments.js'
import { areBackgroundTasksDisabled } from '../envUtils.js'

/**
 * CC 2.1.286 (item 57/--bare hardening) — pure-logic tests for the two
 * TRUE-NEW official primitives ported into OCC.
 *
 * Binary forensics (offsets into /tmp/cc-diff-286/v286/package/claude;
 * v285 = /tmp/cc-diff-286/v285/package/claude):
 *
 * (a) Central background-tasks gate — official `yl` @202370763 (v286):
 *       `function yl(){return GM().backgroundTasksDisabled||
 *        a.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS||Rr()}`
 *     vs v285 `El` @201263733:
 *       `function El(){return LH().backgroundTasksDisabled||
 *        a.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS}`
 *     → TRUE-NEW `||Rr()` (Rr ≡ OCC isBareMode: env CLAUDE_CODE_SIMPLE or
 *     argv --bare). Ported as areBackgroundTasksDisabled() in envUtils.ts
 *     (the `backgroundTasksDisabled` settings key has no OCC counterpart —
 *     pre-existing divergence). OCC consumers switched to the central gate:
 *     BashTool.tsx (schema strip / auto-background / run_in_background),
 *     BashTool prompt.ts + UI.tsx, PowerShellTool.tsx + prompt.ts (×2),
 *     SkillTool.ts, AgentTool.tsx + prompt.ts, SessionBackgroundHint.tsx.
 *
 * (b) Bare attachment filter — official TRUE-NEW `Nen` @204280727:
 *       `function Nen(e){if(!Rr())return!1;let{type:n}=e.attachment;
 *        return n!=="queued_command"&&n!=="poll_events"}`
 *     Ported as isBareFilteredAttachment() in attachments.ts. Consumers:
 *       1. normalize loop @208088367 `case"attachment":{if(Nen(Do))continue;`
 *          — OCC satisfies this at the SOURCE: getAttachments()'s bare gate
 *          (now isBareMode(), was env-only) already returns only
 *          queued_command attachments in bare mode.
 *       2. read_truncation_notice @208081215 — feature absent in OCC (N/A).
 *       3. Stop-hook generator @212100178 `if(!Nen(ue))rt.push(ue);yield ue`
 *          vs v285 @210940248 `it.push(fe),yield fe` — ported into
 *          stopHooks.ts: gates ONLY collectedAdditionalContexts.push; the
 *          yield stays unconditional.
 *
 * STAGED (no OCC surface — not invented):
 *   - `Imn` = "Background tasks are disabled in this session." exported with
 *     yl; its only consumer @202391061 is the SDK `background_tasks`
 *     control_request rejection. OCC has no SDK background_tasks control
 *     handler (--bg redirects to the daemon supervisor per the documented
 *     OCC-21 CLI divergence), so there is no site to attach the message to.
 *   - Plugin `$.tool.register` bare refusal in `aio` @205753489 (guard
 *     `rgn` @197913631: pluginId endsWith "@builtin" with no other "@";
 *     `b_` = path.basename @197239617). OCC plugins expose only
 *     skills/hooks/mcpServers (types/plugin.ts BuiltinPluginDefinition has
 *     no tools field) — the refusal is structurally unreachable in OCC.
 *   - Auto-discovered MCP skip under bare: already satisfied —
 *     main.tsx:2120 `strictMcpConfig || isBareMode()`.
 */

const BG_ENV = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'
const BARE_ENV = 'CLAUDE_CODE_SIMPLE'

let savedBg: string | undefined
let savedBare: string | undefined

beforeEach(() => {
  savedBg = process.env[BG_ENV]
  savedBare = process.env[BARE_ENV]
  delete process.env[BG_ENV]
  delete process.env[BARE_ENV]
})

afterEach(() => {
  if (savedBg === undefined) delete process.env[BG_ENV]
  else process.env[BG_ENV] = savedBg
  if (savedBare === undefined) delete process.env[BARE_ENV]
  else process.env[BARE_ENV] = savedBare
})

describe('areBackgroundTasksDisabled — official yl @202370763', () => {
  test('false when neither env nor bare mode is active', () => {
    expect(areBackgroundTasksDisabled()).toBe(false)
  })

  test('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 disables (v285 behavior kept)', () => {
    process.env[BG_ENV] = '1'
    expect(areBackgroundTasksDisabled()).toBe(true)
  })

  test('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=0 does NOT disable', () => {
    process.env[BG_ENV] = '0'
    expect(areBackgroundTasksDisabled()).toBe(false)
  })

  test('bare mode via CLAUDE_CODE_SIMPLE=1 disables (TRUE-NEW ||Rr())', () => {
    process.env[BARE_ENV] = '1'
    expect(areBackgroundTasksDisabled()).toBe(true)
  })

  test('bare mode via CLAUDE_CODE_SIMPLE=yes disables (isEnvTruthy parse)', () => {
    process.env[BARE_ENV] = 'yes'
    expect(areBackgroundTasksDisabled()).toBe(true)
  })

  test('CLAUDE_CODE_SIMPLE=0 is not bare → stays enabled', () => {
    process.env[BARE_ENV] = '0'
    expect(areBackgroundTasksDisabled()).toBe(false)
  })
})

describe('isBareFilteredAttachment — official Nen @204280727', () => {
  const msg = (type?: string) =>
    ({ attachment: type === undefined ? undefined : { type } }) as {
      attachment?: { type?: string }
    }

  test('non-bare: nothing is filtered (official early `if(!Rr())return!1`)', () => {
    // Arrange / Act / Assert — env unset in beforeEach → not bare.
    expect(isBareFilteredAttachment(msg('hook_additional_context'))).toBe(false)
    expect(isBareFilteredAttachment(msg('queued_command'))).toBe(false)
    expect(isBareFilteredAttachment(msg('file'))).toBe(false)
  })

  test('bare: hook_additional_context is filtered', () => {
    process.env[BARE_ENV] = '1'
    expect(isBareFilteredAttachment(msg('hook_additional_context'))).toBe(true)
  })

  test('bare: other attachment types are filtered', () => {
    process.env[BARE_ENV] = '1'
    expect(isBareFilteredAttachment(msg('file'))).toBe(true)
    expect(isBareFilteredAttachment(msg('hook_success'))).toBe(true)
  })

  test('bare: queued_command survives (official keep-list)', () => {
    process.env[BARE_ENV] = '1'
    expect(isBareFilteredAttachment(msg('queued_command'))).toBe(false)
  })

  test('bare: poll_events survives (official keep-list)', () => {
    process.env[BARE_ENV] = '1'
    expect(isBareFilteredAttachment(msg('poll_events'))).toBe(false)
  })

  test('bare: missing attachment payload → type undefined → filtered', () => {
    // Official destructures `{type:n}=e.attachment`; a missing payload yields
    // undefined type, which is neither keep-listed → true. OCC guards with
    // optional chaining instead of throwing.
    process.env[BARE_ENV] = '1'
    expect(isBareFilteredAttachment(msg(undefined))).toBe(true)
    expect(isBareFilteredAttachment({})).toBe(true)
  })
})
