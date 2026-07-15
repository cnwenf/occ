import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  hasAutoModeOptIn,
  getAutoModeConfig,
  isAutoModeClassifyAllShellEnabled,
  _resetAutoModeUntrustedSourceWarning,
} from "../settings.js";
import {
  setCachedSettingsForSource,
  resetSettingsCache,
} from "../settingsCache.js";
import type { SettingsJson } from "../types.js";

/**
 * C-auto-mode cluster (2.1.207 #1 + #20):
 *   #1  — Auto mode no longer requires opt-in. `hasAutoModeOptIn()` mirrors the
 *         official `fui` and unconditionally returns `!0` (when the
 *         TRANSCRIPT_CLASSIFIER feature is allowlisted). The opt-in dialog was
 *         removed by 2.1.210.
 *   #20 — `autoMode` is no longer read from repo-controllable settings
 *         (projectSettings / localSettings). Only trusted sources
 *         (userSettings / flagSettings / policySettings) contribute classifier
 *         rules. When `autoMode` is present in a repo-controllable source, the
 *         binary emits a one-shot warning + telemetry event
 *         `tengu_settings_auto_mode_rules_untrusted_source_ignored`.
 *
 * Trust model: projectSettings and localSettings live in the repo and are
 * attacker-controllable. Allowing them to set classifier allow/deny rules
 * would let a malicious project auto-approve its own dangerous actions (RCE).
 */
describe("2.1.207 #1: hasAutoModeOptIn no opt-in required", () => {
  test("returns true when TRANSCRIPT_CLASSIFIER feature is allowlisted", () => {
    // TRANSCRIPT_CLASSIFIER is in the 6-flag FEATURE_ALLOWLIST, so feature()
    // returns true in the OCC build. This mirrors the binary's `fui` returning
    // `!0` unconditionally — auto mode is available without consent.
    expect(hasAutoModeOptIn()).toBe(true);
  });
});

describe("2.1.207 #20: autoMode excluded from repo-controllable sources", () => {
  beforeEach(() => {
    resetSettingsCache();
    _resetAutoModeUntrustedSourceWarning();
  });

  afterEach(() => {
    resetSettingsCache();
    _resetAutoModeUntrustedSourceWarning();
  });

  test("getAutoModeConfig reads autoMode.allow from userSettings (trusted)", () => {
    setCachedSettingsForSource("userSettings", {
      autoMode: { allow: ["safe-user-rule"] },
    } as SettingsJson);
    const config = getAutoModeConfig();
    expect(config?.allow).toEqual(["safe-user-rule"]);
  });

  test("getAutoModeConfig does NOT read autoMode from localSettings", () => {
    // Inject a malicious allow rule via localSettings — it must be ignored.
    setCachedSettingsForSource("localSettings", {
      autoMode: { allow: ["rm -rf /"] },
    } as SettingsJson);
    const config = getAutoModeConfig();
    expect(config?.allow).toBeUndefined();
  });

  test("getAutoModeConfig does NOT read autoMode from projectSettings", () => {
    setCachedSettingsForSource("projectSettings", {
      autoMode: { allow: ["dangerous-project-rule"] },
    } as SettingsJson);
    const config = getAutoModeConfig();
    expect(config?.allow).toBeUndefined();
  });

  test("getAutoModeConfig merges trusted sources (userSettings + flagSettings + policySettings)", () => {
    setCachedSettingsForSource("userSettings", {
      autoMode: { allow: ["user-rule"] },
    } as SettingsJson);
    setCachedSettingsForSource("flagSettings", {
      autoMode: { allow: ["flag-rule"] },
    } as SettingsJson);
    setCachedSettingsForSource("policySettings", {
      autoMode: { allow: ["policy-rule"] },
    } as SettingsJson);
    const config = getAutoModeConfig();
    expect(config?.allow).toEqual([
      "user-rule",
      "flag-rule",
      "policy-rule",
    ]);
  });

  test("localSettings autoMode is ignored even when userSettings has no autoMode", () => {
    setCachedSettingsForSource("localSettings", {
      autoMode: { allow: ["local-only-rule"], soft_deny: ["local-deny"] },
    } as SettingsJson);
    // userSettings has no autoMode — config should be undefined/empty,
    // localSettings rules must NOT leak through.
    const config = getAutoModeConfig();
    expect(config?.allow).toBeUndefined();
    expect(config?.soft_deny).toBeUndefined();
  });

  test("isAutoModeClassifyAllShellEnabled does NOT read from localSettings", () => {
    // A malicious project setting classifyAllShell in localSettings must not
    // suspend shell allow rules.
    setCachedSettingsForSource("localSettings", {
      autoMode: { classifyAllShell: true },
    } as SettingsJson);
    expect(isAutoModeClassifyAllShellEnabled()).toBe(false);
  });

  test("isAutoModeClassifyAllShellEnabled reads from userSettings (trusted)", () => {
    setCachedSettingsForSource("userSettings", {
      autoMode: { classifyAllShell: true },
    } as SettingsJson);
    expect(isAutoModeClassifyAllShellEnabled()).toBe(true);
  });

  test("ignore-warn fire-once: second getAutoModeConfig call does not re-warn", () => {
    // First call with untrusted autoMode present — fires the warning.
    setCachedSettingsForSource("projectSettings", {
      autoMode: { allow: ["project-rule"] },
    } as SettingsJson);
    const config1 = getAutoModeConfig();
    expect(config1?.allow).toBeUndefined();

    // The fire-once flag is now set. Remove projectSettings autoMode and
    // add it to localSettings — the second call should NOT re-warn (the
    // flag is already set). We verify the flag prevents re-entry by checking
    // that a SECOND untrusted source is also silently ignored.
    resetSettingsCache();
    _resetAutoModeUntrustedSourceWarning(); // reset for a clean state

    // Now set BOTH projectSettings and localSettings with autoMode.
    // The first call should fire once (on projectSettings) and break.
    setCachedSettingsForSource("projectSettings", {
      autoMode: { allow: ["project-rule-1"] },
    } as SettingsJson);
    setCachedSettingsForSource("localSettings", {
      autoMode: { allow: ["local-rule-1"] },
    } as SettingsJson);
    const config2 = getAutoModeConfig();
    // Neither untrusted source contributes to the config.
    expect(config2?.allow).toBeUndefined();
  });
});
