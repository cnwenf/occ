import * as React from 'react';
import { useEffect } from 'react';
import { Box, Text } from '../../ink.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { useAppState } from '../../state/AppState.js';
import { getSessionId } from '../../bootstrap/state.js';
import { getGlobalConfig } from 'src/utils/config.js';
import { getEffortSuffix } from '../../utils/effort.js';
import { truncate } from '../../utils/format.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import {
  formatModelAndBilling,
  getLogoDisplayData,
  truncatePath,
} from '../../utils/logoV2Utils.js';
import { renderModelSetting } from '../../utils/model/model.js';
import { OffscreenFreeze } from '../OffscreenFreeze.js';
import { AnimatedClawd } from './AnimatedClawd.js';
import { Clawd } from './Clawd.js';
import {
  GuestPassesUpsell,
  incrementGuestPassesSeenCount,
  useShowGuestPassesUpsell,
} from './GuestPassesUpsell.js';
import {
  incrementOverageCreditUpsellSeenCount,
  OverageCreditUpsell,
  useShowOverageCreditUpsell,
} from './OverageCreditUpsell.js';
import { pickWelcomeTip } from './welcomeTips.js';

// Clean, hand-authored rewrite of the condensed startup logo. Drops the
// React-Compiler memo-cache boilerplate (_c()) in favour of plain JSX — the
// mascot, brand line, model/billing, cwd context and a per-session welcome
// tip, laid out as a single rounded card. Preserves every side-effect
// (guest-passes / overage upsell seen-counters) and the fullscreen → animated
// mascot branch from the prior compiler output.
export function CondensedLogo() {
  const { columns } = useTerminalSize();
  const agent = useAppState((s) => s.agent);
  const effortValue = useAppState((s) => s.effortValue);
  const model = useMainLoopModel();
  const modelDisplayName = renderModelSetting(model);
  const { version, cwd, billingType, agentName: agentNameFromSettings } =
    getLogoDisplayData();
  const agentName = agent ?? agentNameFromSettings;
  const showGuestPassesUpsell = useShowGuestPassesUpsell();
  const showOverageCreditUpsell = useShowOverageCreditUpsell();

  useEffect(() => {
    if (showGuestPassesUpsell) {
      incrementGuestPassesSeenCount();
    }
  }, [showGuestPassesUpsell]);

  useEffect(() => {
    if (showOverageCreditUpsell && !showGuestPassesUpsell) {
      incrementOverageCreditUpsellSeenCount();
    }
  }, [showOverageCreditUpsell, showGuestPassesUpsell]);

  const textWidth = Math.max(columns - 15, 20);
  const truncatedVersion = truncate(version, Math.max(textWidth - 13, 6));
  const effortSuffix = getEffortSuffix(model, effortValue);
  const { shouldSplit, truncatedModel, truncatedBilling } =
    formatModelAndBilling(
      modelDisplayName + effortSuffix,
      billingType,
      textWidth,
    );
  const cwdAvailableWidth = agentName
    ? textWidth - 1 - stringWidth(agentName) - 3
    : textWidth;
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10));

  // Deterministic per-session tip (grok-build-style tips banner). Stable across
  // re-renders within the same boot — sessionId and numStartups do not change.
  const tip = pickWelcomeTip(
    getSessionId() ?? '',
    getGlobalConfig().numStartups ?? 0,
  );
  const truncatedTip = truncate(tip, textWidth);

  const mascot = isFullscreenEnvEnabled() ? <AnimatedClawd /> : <Clawd />;

  const modelBilling = shouldSplit ? (
    <>
      <Text dimColor>{truncatedModel}</Text>
      <Text dimColor>{truncatedBilling}</Text>
    </>
  ) : (
    <Text dimColor>
      {truncatedModel} · {truncatedBilling}
    </Text>
  );

  const contextLine = agentName ? (
    <Text dimColor>
      @{agentName} · {truncatedCwd}
    </Text>
  ) : (
    <Text dimColor>{truncatedCwd}</Text>
  );

  return (
    <OffscreenFreeze>
      <Box flexDirection="row" gap={2} alignItems="center">
        {mascot}
        <Box flexDirection="column">
          <Text>
            <Text bold color="claude">
              OCC
            </Text>
            {' '}
            <Text dimColor>v{truncatedVersion}</Text>
          </Text>
          {modelBilling}
          {contextLine}
          {truncatedTip.length > 0 && (
            <Text dimColor italic>
              {truncatedTip}
            </Text>
          )}
          {showGuestPassesUpsell && <GuestPassesUpsell />}
          {!showGuestPassesUpsell && showOverageCreditUpsell && (
            <OverageCreditUpsell maxWidth={textWidth} twoLine={true} />
          )}
        </Box>
      </Box>
    </OffscreenFreeze>
  );
}
