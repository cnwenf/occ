import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Link, Text } from '../ink.js';
import { hasAutoModeOptInDismissed, updateSettingsForSource } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';

// NOTE: This copy is legally reviewed — do not modify without Legal team approval.
// Verbatim from the official 2.1.200 `lPc` (the Enable auto mode? opt-in dialog description).
export const AUTO_MODE_DESCRIPTION = "Auto mode lets Claude handle permission prompts automatically — Claude checks each tool call for risky actions and prompt injection before executing. Actions Claude identifies as safe are executed, while actions Claude identifies as risky are blocked and Claude may try a different approach. Ideal for long-running tasks. Sessions are slightly more expensive. Claude can make mistakes that allow harmful commands to run, it's recommended to only use in isolated environments. Shift+Tab to change mode.";
type Props = {
  onAccept(): void;
  onDecline(reason: "go-back" | "dont-ask"): void;
  // Startup gate: decline exits the process, so relabel accordingly.
  declineExits?: boolean;
};
export function AutoModeOptInDialog(t0) {
  const $ = _c(18);
  const {
    onAccept,
    onDecline,
    declineExits
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [];
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  React.useEffect(_temp, t1);
  let t2;
  if ($[1] !== onAccept || $[2] !== onDecline) {
    t2 = function onChange(value) {
      bb3: switch (value) {
        case "accept":
          {
            logEvent("tengu_auto_mode_opt_in_dialog_accept", {});
            updateSettingsForSource("userSettings", {
              skipAutoPermissionPrompt: true,
              // Clear any prior dismissal (mirrors official A$m): accepting auto
              // mode re-enables the opt-in dialog for future sessions.
              autoModeOptInDismissed: hasAutoModeOptInDismissed() ? false : undefined,
            });
            onAccept();
            break bb3;
          }
        case "accept-default":
          {
            logEvent("tengu_auto_mode_opt_in_dialog_accept_default", {});
            updateSettingsForSource("userSettings", {
              skipAutoPermissionPrompt: true,
              permissions: {
                defaultMode: "auto"
              },
              autoModeOptInDismissed: hasAutoModeOptInDismissed() ? false : undefined,
            });
            onAccept();
            break bb3;
          }
        case "decline":
          {
            logEvent("tengu_auto_mode_opt_in_dialog_decline", {});
            onDecline("go-back");
            break bb3;
          }
        case "decline-dont-ask":
          {
            // "No, don't ask again" — persist dismissal so the opt-in dialog
            // is not shown again on future Shift+Tab cycles. Mirrors official
            // autoModeOptInDismissed + tengu_auto_mode_opt_in_dialog_decline_dont_ask.
            // Idempotent guard (official: if(!Pt().autoModeOptInDismissed)_n(E$m)).
            logEvent("tengu_auto_mode_opt_in_dialog_decline_dont_ask", {});
            if (!hasAutoModeOptInDismissed()) {
              updateSettingsForSource("userSettings", {
                autoModeOptInDismissed: true
              });
            }
            onDecline("dont-ask");
            break bb3;
          }
      }
    };
    $[1] = onAccept;
    $[2] = onDecline;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const onChange = t2;
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Box flexDirection="column" gap={1}><Text>{AUTO_MODE_DESCRIPTION}</Text><Link url="https://code.claude.com/docs/en/security" /></Box>;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = true ? [{
      label: "Yes, and make it my default mode",
      value: "accept-default" as const
    }] : [];
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  let t5;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      label: "Yes, enable auto mode",
      value: "accept" as const
    };
    $[6] = t5;
  } else {
    t5 = $[6];
  }
  const t6 = declineExits ? "No, exit" : "No, go back";
  let t7;
  if ($[7] !== t6) {
    t7 = [...t4, t5, {
      label: t6,
      value: "decline" as const
    }, ...(declineExits ? [] : [{
      label: "No, don't ask again",
      value: "decline-dont-ask" as const
    }])];
    $[7] = t6;
    $[8] = t7;
  } else {
    t7 = $[8];
  }
  let t8;
  if ($[9] !== onChange) {
    t8 = value_0 => onChange(value_0 as 'accept' | 'accept-default' | 'decline' | 'decline-dont-ask');
    $[9] = onChange;
    $[10] = t8;
  } else {
    t8 = $[10];
  }
  let t9;
  if ($[11] !== onDecline || $[12] !== t7 || $[13] !== t8) {
    t9 = <Select options={t7} onChange={t8} onCancel={onDecline} />;
    $[11] = onDecline;
    $[12] = t7;
    $[13] = t8;
    $[14] = t9;
  } else {
    t9 = $[14];
  }
  let t10;
  if ($[15] !== onDecline || $[16] !== t9) {
    t10 = <Dialog title="Enable auto mode?" color="warning" onCancel={onDecline}>{t3}{t9}</Dialog>;
    $[15] = onDecline;
    $[16] = t9;
    $[17] = t10;
  } else {
    t10 = $[17];
  }
  return t10;
}
function _temp() {
  logEvent("tengu_auto_mode_opt_in_dialog_shown", {});
}
