import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { type EffortValue, getDisplayedEffortLevel, getEffortEnvOverride, getEffortValueDescription, isEffortLevel, modelSupportsXhighEffort, toPersistableEffort } from '../../utils/effort.js';
import { clampEffortToCap, buildEffortArgumentHint, formatEffortValidOptions, getAllowedEffortLevels, isEffortLevelAllowed, isUltracodeAvailableForModel } from '../../utils/effort/cap.js';
import { disableUltracodeForSession, enableUltracodeForSession, isUltracodeEnabled, ULTRACODE_ACTIVATION_MESSAGE } from '../../utils/effort/ultracode.js';
import { getMainLoopModel } from '../../utils/model/model.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
const COMMON_HELP_ARGS = ['help', '-h', '--help'];
// OCC-82 (official 2.1.267): byte-verified model-list constant `sYt` shown in
// the ultracode "switch to an xhigh-capable model" hint.
const XHIGH_CAPABLE_MODELS_HINT = 'Fable 5, Opus 4.7+, Sonnet 5';
// Official `wQv` short help descriptions used by the /effort help builder
// (byte-verified; distinct from the longer getEffortLevelDescription texts).
const SHORT_EFFORT_HELP: Record<string, string> = {
  low: 'Quick, straightforward implementation',
  medium: 'Balanced approach with standard testing',
  high: 'Comprehensive implementation with extensive testing',
  xhigh: 'Extended reasoning with thorough analysis (Fable 5, Opus 4.7+, Sonnet 5)',
  max: 'Maximum capability with deepest reasoning (Fable 5, Opus 4.6+, Sonnet 4.6+)'
};
type EffortCommandResult = {
  message: string;
  effortUpdate?: {
    value: EffortValue | undefined;
  };
};
function setEffortValue(effortValue: EffortValue): EffortCommandResult {
  // OCC-82 (official 2.1.267 `U`): the settings effort cap clamps an
  // over-cap request BEFORE any persist — the clamped value applies to the
  // session only and nothing is written to settings.
  const model = getMainLoopModel();
  const clamped =
    typeof effortValue === 'string'
      ? clampEffortToCap(effortValue, model)
      : effortValue;
  if (clamped !== effortValue) {
    logEvent('tengu_effort_command', {
      effort: effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    return {
      message: `Effort '${effortValue}' exceeds the cap for ${model} set by your settings or organization; set to '${clamped}' instead (this session only): ${getEffortValueDescription(clamped)}`,
      effortUpdate: {
        value: clamped
      }
    };
  }
  const persistable = toPersistableEffort(effortValue);
  if (persistable !== undefined) {
    const result = updateSettingsForSource('userSettings', {
      effortLevel: persistable
    });
    if (result.error) {
      return {
        message: `Failed to set effort level: ${result.error.message}`
      };
    }
  }
  logEvent('tengu_effort_command', {
    effort: effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });

  // Env var wins at resolveAppliedEffort time. Only flag it when it actually
  // conflicts — if env matches what the user just asked for, the outcome is
  // the same, so "Set effort to X" is true and the note is noise.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== effortValue) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    if (persistable === undefined) {
      return {
        message: `Not applied: CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides effort this session, and ${effortValue} is session-only (nothing saved)`,
        effortUpdate: {
          value: effortValue
        }
      };
    }
    return {
      message: `CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides this session — clear it and ${effortValue} takes over`,
      effortUpdate: {
        value: effortValue
      }
    };
  }
  const description = getEffortValueDescription(effortValue);
  // OCC-97 (Gap-97c): official 2.1.233 appends the persist note when the
  // level was written to settings (byte-verified suffix strings).
  const suffix =
    persistable !== undefined
      ? ' (saved as your default for new sessions)'
      : ' (this session only)';
  return {
    message: `Set effort level to ${effortValue}${suffix}: ${description}`,
    effortUpdate: {
      value: effortValue
    }
  };
}
export function showCurrentEffort(appStateEffort: EffortValue | undefined, model: string): EffortCommandResult {
  const envOverride = getEffortEnvOverride();
  const effectiveValue = envOverride === null ? undefined : envOverride ?? appStateEffort;
  if (effectiveValue === undefined) {
    const level = getDisplayedEffortLevel(model, appStateEffort);
    return {
      message: `Effort level: auto (currently ${level})`
    };
  }
  const description = getEffortValueDescription(effectiveValue);
  return {
    message: `Current effort level: ${effectiveValue} (${description})`
  };
}
function unsetEffortLevel(): EffortCommandResult {
  const result = updateSettingsForSource('userSettings', {
    effortLevel: undefined
  });
  if (result.error) {
    return {
      message: `Failed to set effort level: ${result.error.message}`
    };
  }
  logEvent('tengu_effort_command', {
    effort: 'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  // env=auto/unset (null) matches what /effort auto asks for, so only warn
  // when env is pinning a specific level that will keep overriding.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== null) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    return {
      message: `Cleared effort from settings, but CLAUDE_CODE_EFFORT_LEVEL=${envRaw} still controls this session`,
      effortUpdate: {
        value: undefined
      }
    };
  }
  return {
    message: 'Effort level set to auto',
    effortUpdate: {
      value: undefined
    }
  };
}
// K3 (2.1.154, ultracode): `/effort ultracode` turns on the ultracode session
// mode — xhigh effort plus standing dynamic-workflow orchestration. It is
// session-scoped (never persisted by interactive toggles, matching the
// binary), so it sets the in-memory effort to xhigh via effortUpdate without
// calling updateSettingsForSource.
// OCC-82 (official 2.1.267 `O`): the two portable gates fire first — (2) the
// cap gate when the model supports xhigh but the cap blocks it, then (3) the
// support gate when the model can't run xhigh at all. (Gate 1 is the official
// dynamic-workflows-enabled check, always live in OCC; the launch-pin gate is
// an ant-only surface OCC doesn't ship — both documented in the gap ledger.)
function enableUltracode(model: string): EffortCommandResult {
  if (modelSupportsXhighEffort(model) && !isEffortLevelAllowed('xhigh', model)) {
    return {
      message: `Ultracode runs at xhigh effort, which is above the effort cap for ${model} set by your settings or organization. Valid options are: ${formatEffortValidOptions(model)}`
    };
  }
  if (!isUltracodeAvailableForModel(model)) {
    return {
      message: `Ultracode runs at xhigh effort, which ${model} doesn't support — switch to an xhigh-capable model (${XHIGH_CAPABLE_MODELS_HINT}). Valid options are: ${formatEffortValidOptions(model)}`
    };
  }
  enableUltracodeForSession();
  logEvent('tengu_effort_command', {
    effort: 'ultracode' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  return {
    message: ULTRACODE_ACTIVATION_MESSAGE,
    effortUpdate: {
      value: 'xhigh'
    }
  };
}

export function executeEffort(args: string): EffortCommandResult {
  // Official 2.1.233 argument parsing (byte-verified `R9t`): trim, lowercase,
  // then the alias table {med: "medium"} before level validation (Gap-97c).
  const normalizedAlias: Record<string, string> = { med: 'medium' };
  const normalized =
    normalizedAlias[args.trim().toLowerCase()] ?? args.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'unset') {
    // K3: switching to auto turns ultracode off (if it was on), emitting the
    // ultra_effort_exit reminder on the next turn via getUltracodeTurnReminders().
    if (isUltracodeEnabled()) {
      disableUltracodeForSession();
    }
    return unsetEffortLevel();
  }
  // K3: ultracode is a session mode, not a persistable effort level — handle
  // it before the isEffortLevel check so it never hits the invalid-arg path.
  if (normalized === 'ultracode') {
    return enableUltracode(getMainLoopModel());
  }
  if (!isEffortLevel(normalized)) {
    // OCC-82 (official 2.1.267 `E(t)`): the valid-options list is now
    // model/cap-aware — allowed levels (S9) + conditional ultracode + auto.
    return {
      message: `Invalid argument: ${args}. Valid options are: ${formatEffortValidOptions(getMainLoopModel())}`
    };
  }
  // K3: switching to a concrete non-ultracode effort level turns ultracode off
  // (if it was on), emitting the ultra_effort_exit reminder on the next turn.
  if (isUltracodeEnabled()) {
    disableUltracodeForSession();
  }
  return setEffortValue(normalized);
}
function ShowCurrentEffort(t0) {
  const {
    onDone
  } = t0;
  const effortValue = useAppState(_temp);
  const model = useMainLoopModel();
  const {
    message
  } = showCurrentEffort(effortValue, model);
  onDone(message);
  return null;
}
function _temp(s) {
  return s.effortValue;
}
function ApplyEffortAndClose(t0) {
  const $ = _c(6);
  const {
    result,
    onDone
  } = t0;
  const setAppState = useSetAppState();
  const {
    effortUpdate,
    message
  } = result;
  let t1;
  let t2;
  if ($[0] !== effortUpdate || $[1] !== message || $[2] !== onDone || $[3] !== setAppState) {
    t1 = () => {
      if (effortUpdate) {
        setAppState(prev => ({
          ...prev,
          effortValue: effortUpdate.value
        }));
      }
      onDone(message);
    };
    t2 = [setAppState, effortUpdate, message, onDone];
    $[0] = effortUpdate;
    $[1] = message;
    $[2] = onDone;
    $[3] = setAppState;
    $[4] = t1;
    $[5] = t2;
  } else {
    t1 = $[4];
    t2 = $[5];
  }
  React.useEffect(t1, t2);
  return null;
}
export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  args = args?.trim() || '';
  if (COMMON_HELP_ARGS.includes(args)) {
    // OCC-97 (Gap-97c) + OCC-82 (official 2.1.267 `Jdt`): the help builder is
    // now cap-aware — usage line via the official argumentHint builder (S9
    // allowed levels + conditional ultracode + auto), one `- level: desc` line
    // per ALLOWED level (short wQv descriptions), then the conditional
    // ultracode line and the auto line. Model-list suffixes are byte-verified:
    // o2o = "Fable 5, Opus 4.7+, Sonnet 5" (xhigh),
    // wud = "Fable 5, Opus 4.6+, Sonnet 4.6+" (max).
    const model = getMainLoopModel();
    const lines = [buildEffortArgumentHint('Usage: /effort [', ']', model)];
    for (const level of getAllowedEffortLevels(model)) {
      lines.push(`- ${level}: ${SHORT_EFFORT_HELP[level]}`);
    }
    if (isUltracodeAvailableForModel(model)) {
      lines.push('- ultracode: xhigh + dynamic workflow orchestration (this session only)');
    }
    lines.push('- auto: Use the default effort level for your model');
    onDone(lines.join('\n'));
    return;
  }
  if (!args || args === 'current' || args === 'status') {
    return <ShowCurrentEffort onDone={onDone} />;
  }
  const result = executeEffort(args);
  return <ApplyEffortAndClose result={result} onDone={onDone} />;
}
