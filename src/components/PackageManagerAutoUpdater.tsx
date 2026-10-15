import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useState } from 'react';
import { useInterval } from 'usehooks-ts';
import { Text } from '../ink.js';
import { type AutoUpdaterResult, getLatestVersionFromGcs, getMaxVersion, shouldSkipVersion } from '../utils/autoUpdater.js';
import { isAutoUpdaterDisabled } from '../utils/config.js';
import { logForDebugging } from '../utils/debug.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { getPackageManager, type PackageManager } from '../utils/nativeInstaller/packageManagers.js';
import { gt, gte } from '../utils/semver.js';
import { getInitialSettings } from '../utils/settings/settings.js';
import { UpdaterSeparator } from './UpdaterSeparator.js';
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
  // Official v299 (#049): undefined → no separator node; true → leading
  // dim " ·" so the notice renders BESIDE other status chrome.
  withSeparator?: boolean;
};
export function PackageManagerAutoUpdater(t0) {
  const $ = _c(13);
  const {
    verbose,
    withSeparator
  } = t0;
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [packageManager, setPackageManager] = useState("unknown");
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = async () => {
      false || false;
      if (isAutoUpdaterDisabled()) {
        return;
      }
      // 2.1.129: package-manager (npm/bun/brew) auto-update is opt-in via
      // CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE. The native installer path is
      // the default; this gate keeps package-manager auto-updates dormant
      // unless explicitly enabled. Mirrors official
      // K=it(process.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE); if(!K)return
      if (!isEnvTruthy(process.env.CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE)) {
        return;
      }
      const [channel, pm] = await Promise.all([Promise.resolve(getInitialSettings()?.autoUpdatesChannel ?? "latest"), getPackageManager()]);
      setPackageManager(pm);
      let latest = await getLatestVersionFromGcs(channel);
      const maxVersion = await getMaxVersion();
      if (maxVersion && latest && gt(latest, maxVersion)) {
        logForDebugging(`PackageManagerAutoUpdater: maxVersion ${maxVersion} is set, capping update from ${latest} to ${maxVersion}`);
        if (gte(MACRO.VERSION, maxVersion)) {
          logForDebugging(`PackageManagerAutoUpdater: current version ${MACRO.VERSION} is already at or above maxVersion ${maxVersion}, skipping update`);
          setUpdateAvailable(false);
          return;
        }
        latest = maxVersion;
      }
      const hasUpdate = latest && !gte(MACRO.VERSION, latest) && !shouldSkipVersion(latest);
      setUpdateAvailable(!!hasUpdate);
      if (hasUpdate) {
        logForDebugging(`PackageManagerAutoUpdater: Update available ${MACRO.VERSION} -> ${latest}`);
      }
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const checkForUpdates = t1;
  let t2;
  let t3;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => {
      checkForUpdates();
    };
    t3 = [checkForUpdates];
    $[1] = t2;
    $[2] = t3;
  } else {
    t2 = $[1];
    t3 = $[2];
  }
  React.useEffect(t2, t3);
  useInterval(checkForUpdates, 1800000);
  if (!updateAvailable) {
    return null;
  }
  const updateCommand = packageManager === "homebrew" ? "brew upgrade claude-code" : packageManager === "winget" ? "winget upgrade Anthropic.ClaudeCode" : packageManager === "apk" ? "apk upgrade claude-code" : "your package manager update command";
  let tsep;
  if ($[3] !== withSeparator) {
    tsep = <UpdaterSeparator withSeparator={withSeparator} />;
    $[3] = withSeparator;
    $[4] = tsep;
  } else {
    tsep = $[4];
  }
  let t4;
  if ($[5] !== verbose) {
    t4 = verbose && <Text dimColor={true} wrap="truncate">currentVersion: {MACRO.VERSION}</Text>;
    $[5] = verbose;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  let t5;
  if ($[7] !== updateCommand) {
    t5 = <Text color="warning" wrap="truncate">Update available! Run: <Text bold={true}>{updateCommand}</Text></Text>;
    $[7] = updateCommand;
    $[8] = t5;
  } else {
    t5 = $[8];
  }
  let t6;
  if ($[9] !== t4 || $[10] !== t5 || $[11] !== tsep) {
    t6 = <>{tsep}{t4}{t5}</>;
    $[9] = t4;
    $[10] = t5;
    $[11] = tsep;
    $[12] = t6;
  } else {
    t6 = $[12];
  }
  return t6;
}
