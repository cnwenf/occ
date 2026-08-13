import { c as _c } from "react/compiler-runtime";
import { feature } from 'src/utils/featureFlags.js';
import * as React from 'react';
import { resetCostState } from '../../bootstrap/state.js';
import { clearTrustedDeviceToken, enrollTrustedDevice } from '../../bridge/trustedDevice.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { Text } from '../../ink.js';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { refreshPolicyLimits } from '../../services/policyLimits/index.js';
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { stripSignatureBlocks } from '../../utils/messages.js';
import { getAPIProvider } from '../../utils/model/providers.js';
import { checkAndDisableAutoModeIfNeeded, checkAndDisableBypassPermissionsIfNeeded, resetAutoModeGateCheck, resetBypassPermissionsCheck } from '../../utils/permissions/bypassPermissionsKillswitch.js';
import { resetUserCache } from '../../utils/user.js';

// ---------------------------------------------------------------------------
// CC 2.1.229 (changelog #27): /login repeats the CLAUDE_CODE_OAUTH_TOKEN
// override warning after a successful login. All strings below are byte-exact
// from the 2.1.229 binary (`KWm`/`XWm`/`VWm`/`YWm`/`RRe`).
// ---------------------------------------------------------------------------

/** Shared warning tail (binary `VWm`, byte-exact). */
const ENV_TOKEN_OVERRIDE_WARNING_TAIL =
  'but if that variable is set in your shell profile or a Claude Code settings file, new `claude` sessions will keep using the old token until you remove it there.';

/** Post-login note (binary `YWm`, byte-exact). */
const ENV_TOKEN_OVERRIDE_DONE_NOTE = `Note: CLAUDE_CODE_OAUTH_TOKEN was set in your environment when /login started. This session will use your new credentials, ${ENV_TOKEN_OVERRIDE_WARNING_TAIL}`;

/**
 * Remote Control disconnect note appended to "Login successful." when the
 * bridge dropped during login (binary `RRe`, byte-exact). OCC's Remote
 * Control bridge is trimmed, so this branch is unreachable — kept for
 * byte-parity with the official mechanism.
 */
const REMOTE_CONTROL_DISCONNECTED_NOTE = 'Remote Control disconnected.';

/**
 * Warning shown at the start of /login when CLAUDE_CODE_OAUTH_TOKEN is set
 * in the environment (binary `KWm`).
 */
export function getLoginStartingMessage(): string | undefined {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? `Warning: CLAUDE_CODE_OAUTH_TOKEN is set in your environment. This session will switch to your new credentials after logging in, ${ENV_TOKEN_OVERRIDE_WARNING_TAIL}`
    : undefined;
}

/**
 * /login done message (binary `XWm`, byte-exact — including the two-newline
 * separator before the repeated env-token note).
 */
export function buildLoginDoneMessage(
  success: boolean,
  opts: {
    bridgeDisconnected: boolean
    envTokenWasSet: boolean
    gatewayActive: boolean
  },
): string {
  if (!success) return 'Login interrupted';
  const base = opts.bridgeDisconnected
    ? `Login successful. ${REMOTE_CONTROL_DISCONNECTED_NOTE}`
    : 'Login successful';
  return opts.envTokenWasSet && !opts.gatewayActive
    ? `${base}\n\n${ENV_TOKEN_OVERRIDE_DONE_NOTE}`
    : base;
}

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  // CC 2.1.229 (changelog #27): capture the env-token state at /login start —
  // the done message repeats the warning based on this snapshot, not the
  // post-login environment (binary: `n = r !== void 0` at call entry).
  const startingMessage = getLoginStartingMessage();
  const envTokenWasSet = startingMessage !== undefined;
  return <Login startingMessage={startingMessage} onDone={async success => {
    context.onChangeAPIKey();
    // Signature-bearing blocks (thinking, connector_text) are bound to the API key —
    // strip them so the new key doesn't reject stale signatures.
    context.setMessages(stripSignatureBlocks);
    if (success) {
      // Post-login refresh logic. Keep in sync with onboarding in src/interactiveHelpers.tsx
      // Reset cost state when switching accounts
      resetCostState();
      // Refresh remotely managed settings after login (non-blocking)
      void refreshRemoteManagedSettings();
      // Refresh policy limits after login (non-blocking)
      void refreshPolicyLimits();
      // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
      resetUserCache();
      // Refresh GrowthBook after login to get updated feature flags (e.g., for claude.ai MCPs)
      refreshGrowthBookAfterAuthChange();
      // Clear any stale trusted device token from a previous account before
      // re-enrolling — prevents sending the old token on bridge calls while
      // the async enrollTrustedDevice() is in-flight.
      clearTrustedDeviceToken();
      // Enroll as a trusted device for Remote Control (10-min fresh-session window)
      void enrollTrustedDevice();
      // Reset killswitch gate checks and re-run with new org
      resetBypassPermissionsCheck();
      const appState = context.getAppState();
      void checkAndDisableBypassPermissionsIfNeeded(appState.toolPermissionContext, context.setAppState);
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        resetAutoModeGateCheck();
        void checkAndDisableAutoModeIfNeeded(appState.toolPermissionContext, context.setAppState, appState.fastMode);
      }
      // Increment authVersion to trigger re-fetching of auth-dependent data in hooks (e.g., MCP servers)
      context.setAppState(prev => ({
        ...prev,
        authVersion: prev.authVersion + 1
      }));
    }
    onDone(buildLoginDoneMessage(success, {
      // Binary: `a.bridgeDisconnected` — OCC's Remote Control bridge is
      // trimmed, so this is always false.
      bridgeDisconnected: false,
      envTokenWasSet,
      // Binary: `Xn()==="gateway"` — OCC's getAPIProvider() never returns
      // 'gateway', so this is always false here; kept for byte-parity.
      gatewayActive: getAPIProvider() === 'gateway'
    }));
  }} />;
}
export function Login(props) {
  const $ = _c(12);
  const mainLoopModel = useMainLoopModel();
  let t0;
  if ($[0] !== mainLoopModel || $[1] !== props) {
    t0 = () => props.onDone(false, mainLoopModel);
    $[0] = mainLoopModel;
    $[1] = props;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  let t1;
  if ($[3] !== mainLoopModel || $[4] !== props) {
    t1 = () => props.onDone(true, mainLoopModel);
    $[3] = mainLoopModel;
    $[4] = props;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  let t2;
  if ($[6] !== props.startingMessage || $[7] !== t1) {
    t2 = <ConsoleOAuthFlow onDone={t1} startingMessage={props.startingMessage} />;
    $[6] = props.startingMessage;
    $[7] = t1;
    $[8] = t2;
  } else {
    t2 = $[8];
  }
  let t3;
  if ($[9] !== t0 || $[10] !== t2) {
    t3 = <Dialog title="Login" onCancel={t0} color="permission" inputGuide={_temp}>{t2}</Dialog>;
    $[9] = t0;
    $[10] = t2;
    $[11] = t3;
  } else {
    t3 = $[11];
  }
  return t3;
}
function _temp(exitState) {
  return exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />;
}
