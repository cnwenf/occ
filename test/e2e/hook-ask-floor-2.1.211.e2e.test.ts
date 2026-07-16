import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * E2E test for CC 2.1.211 "auto mode overriding PreToolUse hook ask" fix.
 *
 * Exercises the REAL decision code (resolveHookPermissionDecision +
 * hasPermissionsToUseTool) — not a stub — via `bun -e` scripts that
 * import the actual source modules.
 *
 * Binary recon evidence:
 *   - `hookAskFloor` appears 0x in CC 2.1.210, 3x in 2.1.211
 *   - `function xOg(){return!1}` — y-check stub returns false
 *   - In resolveHookPermissionDecision: `d?{...n,hookAskFloor:!0}:n`
 *   - In hasPermissionsToUseTool: `_=r.hookAskFloor===!0` → floors at ask
 *
 * The fix: when a PreToolUse hook returns `ask` and rules also require `ask`,
 * `hookAskFloor=true` is passed to canUseTool. In auto mode, this floors the
 * decision at "prompt the user" — the classifier cannot override with allow.
 */

describe('CC 2.1.211 hookAskFloor — real decision code e2e', () => {
  test('resolveHookPermissionDecision passes hookAskFloor when hook ask + rule ask', async () => {
    // This script imports the REAL resolveHookPermissionDecision and calls it
    // with a hook 'ask' result and a tool whose checkPermissions returns ask
    // (safety check). It captures the canUseTool call args.
    const script = `
import { resolveHookPermissionDecision } from "${REPO_ROOT}/src/services/tools/toolHooks.ts";

// Real tool mock — checkPermissions returns ask (safety check)
const tool = {
  name: 'Bash',
  userFacingName: () => 'Bash',
  inputSchema: { parse: (i) => i, safeParse: (i) => ({ success: true, data: i }) },
  checkPermissions: async () => ({
    behavior: 'ask',
    decisionReason: { type: 'safetyCheck', classifierApprovable: false },
    message: 'Safety check',
  }),
  description: async () => 'Bash',
  isMcp: false,
};

const ctx = {
  abortController: { signal: { aborted: false } },
  getAppState: () => ({
    toolPermissionContext: {
      mode: 'auto',
      shouldAvoidPermissionPrompts: false,
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
  }),
  options: { isNonInteractiveSession: false, tools: [] },
};

const msg = { message: { id: 'msg1', content: [] } };

// Capture canUseTool call args
let capturedArgs = null;
const canUseTool = async (tool, input, ctx, msg, id, forceDecision, hookAskFloor) => {
  capturedArgs = { forceDecision, hookAskFloor };
  // Simulate hasPermissionsToUseTool respecting hookAskFloor
  if (hookAskFloor) return { behavior: 'ask', message: 'floored' };
  return { behavior: 'allow', updatedInput: input };
};

const hookResult = { behavior: 'ask', message: 'Hook asks' };
const result = await resolveHookPermissionDecision(
  hookResult, tool, { command: 'rm -rf /' }, ctx, canUseTool, msg, 'id1'
);

console.log(JSON.stringify({
  capturedForceDecision: capturedArgs?.forceDecision ?? null,
  capturedHookAskFloor: capturedArgs?.hookAskFloor ?? null,
  decisionBehavior: result.decision.behavior,
}));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )

    // hookAskFloor should be true (hook returned ask + rule says ask)
    expect(out.capturedHookAskFloor).toBe(true)
    // forceDecision should be null/undefined (not using forceDecision path)
    expect(out.capturedForceDecision).toBeNull()
    // Decision should be ask (floored, not auto-allowed)
    expect(out.decisionBehavior).toBe('ask')
  })

  test('resolveHookPermissionDecision uses forceDecision when hook ask + rule pass', async () => {
    const script = `
import { resolveHookPermissionDecision } from "${REPO_ROOT}/src/services/tools/toolHooks.ts";

// Tool with no rule objection (checkPermissions returns passthrough)
const tool = {
  name: 'Bash',
  userFacingName: () => 'Bash',
  inputSchema: { parse: (i) => i, safeParse: (i) => ({ success: true, data: i }) },
  checkPermissions: async () => ({ behavior: 'passthrough' }),
  description: async () => 'Bash',
  isMcp: false,
};

const ctx = {
  abortController: { signal: { aborted: false } },
  getAppState: () => ({
    toolPermissionContext: {
      mode: 'auto',
      shouldAvoidPermissionPrompts: false,
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
  }),
  options: { isNonInteractiveSession: false, tools: [] },
};

const msg = { message: { id: 'msg1', content: [] } };

let capturedArgs = null;
const canUseTool = async (tool, input, ctx, msg, id, forceDecision, hookAskFloor) => {
  capturedArgs = { forceDecision: forceDecision ? forceDecision.behavior : null, hookAskFloor };
  // forceDecision is set → return it directly
  return forceDecision ?? { behavior: 'allow', updatedInput: input };
};

const hookResult = { behavior: 'ask', message: 'Hook asks' };
const result = await resolveHookPermissionDecision(
  hookResult, tool, { command: 'echo hello' }, ctx, canUseTool, msg, 'id2'
);

console.log(JSON.stringify({
  capturedForceDecision: capturedArgs?.forceDecision ?? null,
  capturedHookAskFloor: capturedArgs?.hookAskFloor ?? null,
  decisionBehavior: result.decision.behavior,
}));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )

    // forceDecision should be 'ask' (hook's ask is used as forceDecision)
    expect(out.capturedForceDecision).toBe('ask')
    // hookAskFloor should be null/undefined (not using hookAskFloor path)
    expect(out.capturedHookAskFloor).toBeNull()
  })

  test('REAL hasPermissionsToUseTool: hookAskFloor=true floors at ask in auto mode (not overridden by acceptEdits fast-path)', async () => {
    // This test calls the REAL hasPermissionsToUseTool (not a mock) via bun -e.
    // It verifies that hookAskFloor=true prevents the auto-mode acceptEdits
    // fast-path from overriding an ask decision with allow.
    //
    // Without the CRITICAL-1 fix (hookAskFloor in wrong param slot), this test
    // fails: the fast-path returns allow instead of ask.
    const script = `
import { hasPermissionsToUseTool } from "${REPO_ROOT}/src/utils/permissions/permissions.ts";

// Tool that returns ask (classifierApprovable safety check) in auto mode,
// but allow in acceptEdits mode (triggers the fast-path that would override).
const tool = {
  name: 'Bash',
  userFacingName: () => 'Bash',
  inputSchema: { parse: (i) => i, safeParse: (i) => ({ success: true, data: i }) },
  checkPermissions: async (_input, ctx) => {
    const mode = ctx.getAppState().toolPermissionContext.mode;
    if (mode === 'acceptEdits') return { behavior: 'allow' };
    return {
      behavior: 'ask',
      decisionReason: { type: 'safetyCheck', classifierApprovable: true },
      message: 'Safety check',
    };
  },
  description: async () => 'Bash',
  isMcp: false,
};

const ctx = {
  abortController: { signal: { aborted: false } },
  getAppState: () => ({
    toolPermissionContext: {
      mode: 'auto',
      shouldAvoidPermissionPrompts: false,
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
    denialTracking: undefined,
  }),
  setAppState: () => {},
  options: { isNonInteractiveSession: false, tools: [] },
  localDenialTracking: undefined,
};

const msg = { message: { id: 'msg1', content: [] } };

// Call the REAL hasPermissionsToUseTool with hookAskFloor=true (6th arg)
const result = await hasPermissionsToUseTool(
  tool, { command: 'rm -rf /' }, ctx, msg, 'e2e-real-1', true
);

console.log(JSON.stringify({ behavior: result.behavior }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )

    // With fix: hookAskFloor floors at ask → behavior is 'ask'
    // Without fix: hookAskFloor in wrong slot, fast-path overrides → 'allow'
    expect(out.behavior).toBe('ask')
    expect(out.behavior).not.toBe('allow')
  })

  test('REAL hasPermissionsToUseTool: hookAskFloor=true denies in headless auto mode', async () => {
    const script = `
import { hasPermissionsToUseTool } from "${REPO_ROOT}/src/utils/permissions/permissions.ts";

const tool = {
  name: 'Bash',
  userFacingName: () => 'Bash',
  inputSchema: { parse: (i) => i, safeParse: (i) => ({ success: true, data: i }) },
  checkPermissions: async (_input, ctx) => {
    const mode = ctx.getAppState().toolPermissionContext.mode;
    if (mode === 'acceptEdits') return { behavior: 'allow' };
    return {
      behavior: 'ask',
      decisionReason: { type: 'safetyCheck', classifierApprovable: true },
      message: 'Safety check',
    };
  },
  description: async () => 'Bash',
  isMcp: false,
};

const ctx = {
  abortController: { signal: { aborted: false } },
  getAppState: () => ({
    toolPermissionContext: {
      mode: 'auto',
      shouldAvoidPermissionPrompts: true, // headless
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
    denialTracking: undefined,
  }),
  setAppState: () => {},
  options: { isNonInteractiveSession: false, tools: [] },
  localDenialTracking: undefined,
};

const msg = { message: { id: 'msg1', content: [] } };

const result = await hasPermissionsToUseTool(
  tool, { command: 'rm -rf /' }, ctx, msg, 'e2e-real-2', true
);

console.log(JSON.stringify({ behavior: result.behavior }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )

    // With fix: headless + hookAskFloor → deny (cannot prompt)
    // Without fix: fast-path overrides → 'allow'
    expect(out.behavior).toBe('deny')
    expect(out.behavior).not.toBe('allow')
  })
})
