import chalk from 'chalk';
import * as React from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { ModelPicker } from '../../components/ModelPicker.js';
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import type { EffortLevel } from '../../utils/effort.js';
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js';
import { clearFastModeCooldown, isFastModeAvailable, isFastModeEnabled, isFastModeSupportedByModel } from '../../utils/fastMode.js';
import { MODEL_ALIASES } from '../../utils/model/aliases.js';
import { checkOpus1mAccess, checkSonnet1mAccess } from '../../utils/model/check1mAccess.js';
import { getDefaultMainLoopModelSetting, isOpus1mMergeEnabled, renderDefaultModelSetting } from '../../utils/model/model.js';
import { isModelAllowed } from '../../utils/model/modelAllowlist.js';
import { validateModel } from '../../utils/model/validateModel.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
// E19 (2.1.117): startup pin header. The picker header explains that the
// selection becomes the default (pinned) for new sessions — i.e. it persists
// across restarts. Mirrors the 2.1.200 binary ModelPicker header text:
// "Switch between Claude models. Your pick becomes the default for new
// sessions. For other/previous model names, specify with --model."
const MODEL_PICKER_PIN_HEADER =
  'Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.';
function ModelPickerWrapper({ onDone }: {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
}) {
  const mainLoopModel = useAppState(s => s.mainLoopModel);
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession);
  const isFastMode = useAppState(s => s.fastMode);
  const setAppState = useSetAppState();

  function handleCancel() {
    logEvent("tengu_model_command_menu", {
      action: "cancel" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    const displayModel = renderModelLabel(mainLoopModel);
    onDone(`Kept model as ${chalk.bold(displayModel)}`, {
      display: "system"
    });
  }

  // E18 (2.1.153): enter = "set as default" — persist the selection to
  // user settings so it survives into new sessions. Mirrors the official
  // 2.1.200 binary: `Set model to X and saved as your default for new sessions`.
  function handleSelect(model: string | null, effort?: EffortLevel) {
    logEvent("tengu_model_command_menu", {
      action: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      from_model: mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    setAppState(prev => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelForSession: null
    }));
    if (model === null) {
      onDone("Model reset to default for this session");
      return;
    }
    // E18: save as default for new sessions.
    updateSettingsForSource("userSettings", { model });
    let message = `Set model to ${chalk.bold(renderModelLabel(model))} and saved as your default for new sessions`;
    if (effort !== undefined) {
      message = message + ` with ${chalk.bold(effort)} effort`;
    }
    let wasFastModeToggledOn: boolean | undefined;
    if (isFastModeEnabled()) {
      clearFastModeCooldown();
      if (!isFastModeSupportedByModel(model) && isFastMode) {
        setAppState(prev => ({
          ...prev,
          fastMode: false
        }));
        wasFastModeToggledOn = false;
      } else {
        if (isFastModeSupportedByModel(model) && isFastModeAvailable() && isFastMode) {
          message = message + " \xB7 Fast mode ON";
          wasFastModeToggledOn = true;
        }
      }
    }
    if (isBilledAsExtraUsage(model, wasFastModeToggledOn === true, isOpus1mMergeEnabled())) {
      message = message + " \xB7 Billed as extra usage";
    }
    if (wasFastModeToggledOn === false) {
      message = message + " \xB7 Fast mode OFF";
    }
    onDone(message);
  }

  // E18 (2.1.153): 's' = "use this session only" — set the model in-memory
  // without persisting, so it reverts for new sessions. Mirrors the official
  // 2.1.200 binary: `Set model to X for this session only`.
  function handleSessionOnlySelect(model: string | null, effort?: EffortLevel) {
    logEvent("tengu_model_command_menu", {
      action: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      from_model: mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    setAppState(prev => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelForSession: null
    }));
    if (model === null) {
      onDone("Model reset to default for this session");
      return;
    }
    let message = `Set model to ${chalk.bold(renderModelLabel(model))} for this session only`;
    if (effort !== undefined) {
      message = message + ` with ${chalk.bold(effort)} effort`;
    }
    let wasFastModeToggledOn: boolean | undefined;
    if (isFastModeEnabled()) {
      clearFastModeCooldown();
      if (!isFastModeSupportedByModel(model) && isFastMode) {
        setAppState(prev => ({
          ...prev,
          fastMode: false
        }));
        wasFastModeToggledOn = false;
      } else {
        if (isFastModeSupportedByModel(model) && isFastModeAvailable() && isFastMode) {
          message = message + " \xB7 Fast mode ON";
          wasFastModeToggledOn = true;
        }
      }
    }
    if (isBilledAsExtraUsage(model, wasFastModeToggledOn === true, isOpus1mMergeEnabled())) {
      message = message + " \xB7 Billed as extra usage";
    }
    if (wasFastModeToggledOn === false) {
      message = message + " \xB7 Fast mode OFF";
    }
    onDone(message);
  }

  const showFastModeNotice = isFastModeEnabled() && isFastMode && isFastModeSupportedByModel(mainLoopModel) && isFastModeAvailable();

  return <ModelPicker initial={mainLoopModel} sessionModel={mainLoopModelForSession} onSelect={handleSelect} onSessionOnlySelect={handleSessionOnlySelect} onCancel={handleCancel} isStandaloneCommand={true} showFastModeNotice={showFastModeNotice} headerText={MODEL_PICKER_PIN_HEADER} />;
}
function SetModelAndClose({
  args,
  onDone
}: {
  args: string;
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
}): React.ReactNode {
  const isFastMode = useAppState(s => s.fastMode);
  const setAppState = useSetAppState();
  const model = args === 'default' ? null : args;
  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      if (model && !isModelAllowed(model)) {
        onDone(`Model '${model}' is not available. Your organization restricts model selection.`, {
          display: 'system'
        });
        return;
      }

      // @[MODEL LAUNCH]: Update check for 1M access.
      if (model && isOpus1mUnavailable(model)) {
        onDone(`Opus 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m`, {
          display: 'system'
        });
        return;
      }
      if (model && isSonnet1mUnavailable(model)) {
        onDone(`Sonnet 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m`, {
          display: 'system'
        });
        return;
      }

      // Skip validation for default model
      if (!model) {
        setModel(null);
        return;
      }

      // Skip validation for known aliases - they're predefined and should work
      if (isKnownAlias(model)) {
        setModel(model);
        return;
      }

      // Validate and set custom model
      try {
        // Don't use parseUserSpecifiedModel for non-aliases since it lowercases the input
        // and model names are case-sensitive
        const {
          valid,
          error: error_0
        } = await validateModel(model);
        if (valid) {
          setModel(model);
        } else {
          onDone(error_0 || `Model '${model}' not found`, {
            display: 'system'
          });
        }
      } catch (error) {
        onDone(`Failed to validate model: ${(error as Error).message}`, {
          display: 'system'
        });
      }
    }
    function setModel(modelValue: string | null): void {
      setAppState(prev => ({
        ...prev,
        mainLoopModel: modelValue,
        mainLoopModelForSession: null
      }));
      // E19 (2.1.117): `/model default` resets to the workspace default for
      // this session. Mirrors the 2.1.200 binary: `Model reset to default for
      // this session`.
      if (modelValue === null) {
        onDone('Model reset to default for this session');
        return;
      }
      // E19 (2.1.117): inline `/model <name>` is session-scoped — it does NOT
      // persist across restarts (only the picker "set as default" path does).
      // Mirrors the 2.1.200 binary: `Model set to X (session-scoped, not
      // persisted)`. Fast mode is still auto-downgraded for unsupported models.
      if (isFastModeEnabled()) {
        clearFastModeCooldown();
        if (!isFastModeSupportedByModel(modelValue) && isFastMode) {
          setAppState(prev_0 => ({
            ...prev_0,
            fastMode: false
          }));
          // Do not update fast mode in settings since this is an automatic downgrade
        }
      }
      onDone(`Model set to ${chalk.bold(renderModelLabel(modelValue))} (session-scoped, not persisted)`);
    }
    void handleModelChange();
  }, [model, onDone, setAppState]);
  return null;
}
function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(model.toLowerCase().trim());
}
function isOpus1mUnavailable(model: string): boolean {
  const m = model.toLowerCase();
  return !checkOpus1mAccess() && !isOpus1mMergeEnabled() && m.includes('opus') && m.includes('[1m]');
}
function isSonnet1mUnavailable(model: string): boolean {
  const m = model.toLowerCase();
  // Warn about Sonnet and Sonnet 4.6, but not Sonnet 4.5 since that had
  // a different access criteria.
  return !checkSonnet1mAccess() && (m.includes('sonnet[1m]') || m.includes('sonnet-4-6[1m]'));
}
function ShowModelAndClose(t0) {
  const {
    onDone
  } = t0;
  const mainLoopModel = useAppState(_temp7);
  const mainLoopModelForSession = useAppState(_temp8);
  const effortValue = useAppState(_temp9);
  const displayModel = renderModelLabel(mainLoopModel);
  const effortInfo = effortValue !== undefined ? ` (effort: ${effortValue})` : "";
  if (mainLoopModelForSession) {
    onDone(`Current model: ${chalk.bold(renderModelLabel(mainLoopModelForSession))} (session override from plan mode)\nBase model: ${displayModel}${effortInfo}`);
  } else {
    onDone(`Current model: ${displayModel}${effortInfo}`);
  }
  return null;
}
function _temp9(s_1) {
  return s_1.effortValue;
}
function _temp8(s_0) {
  return s_0.mainLoopModelForSession;
}
function _temp7(s) {
  return s.mainLoopModel;
}
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || '';
  if (COMMON_INFO_ARGS.includes(args)) {
    logEvent('tengu_model_command_inline_help', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    return <ShowModelAndClose onDone={onDone} />;
  }
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone('Run /model to open the model selection menu, or /model [modelName] to set the model.', {
      display: 'system'
    });
    return;
  }
  if (args) {
    logEvent('tengu_model_command_inline', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    return <SetModelAndClose args={args} onDone={onDone} />;
  }
  return <ModelPickerWrapper onDone={onDone} />;
};
function renderModelLabel(model: string | null): string {
  const rendered = renderDefaultModelSetting(model ?? getDefaultMainLoopModelSetting());
  return model === null ? `${rendered} (default)` : rendered;
}
