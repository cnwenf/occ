import { c as _c } from "react/compiler-runtime";
import { feature } from 'src/utils/featureFlags.js';
import * as React from 'react';
import type { AutoUpdaterResult } from '../utils/autoUpdater.js';
import { isAutoUpdaterDisabled } from '../utils/config.js';
import { logForDebugging } from '../utils/debug.js';
import { getCurrentInstallationType } from '../utils/doctorDiagnostic.js';
import { AutoUpdater } from './AutoUpdater.js';
import { NativeAutoUpdater } from './NativeAutoUpdater.js';
import { PackageManagerAutoUpdater } from './PackageManagerAutoUpdater.js';
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
  // Official v299 (#049): rendered BESIDE other status chrome (e.g. the
  // fullscreen "/clear to save tokens" hint). undefined → no separator node
  // (legacy standalone render); true → leading dim " ·"; false → empty Text.
  withSeparator?: boolean;
};
export function AutoUpdaterWrapper(t0) {
  const $ = _c(19);
  const {
    isUpdating,
    onChangeIsUpdating,
    onAutoUpdaterResult,
    autoUpdaterResult,
    showSuccessMessage,
    verbose,
    withSeparator
  } = t0;
  const [useNativeInstaller, setUseNativeInstaller] = React.useState(null);
  const [isPackageManager, setIsPackageManager] = React.useState(null);
  let t1;
  let t2;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = () => {
      const checkInstallation = async function checkInstallation() {
        if (feature("SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED") && isAutoUpdaterDisabled()) {
          logForDebugging("AutoUpdaterWrapper: Skipping detection, auto-updates disabled");
          return;
        }
        const installationType = await getCurrentInstallationType();
        logForDebugging(`AutoUpdaterWrapper: Installation type: ${installationType}`);
        setUseNativeInstaller(installationType === "native");
        setIsPackageManager(installationType === "package-manager");
      };
      checkInstallation();
    };
    t2 = [];
    $[0] = t1;
    $[1] = t2;
  } else {
    t1 = $[0];
    t2 = $[1];
  }
  React.useEffect(t1, t2);
  if (useNativeInstaller === null || isPackageManager === null) {
    return null;
  }
  if (isPackageManager) {
    let t3;
    if ($[2] !== autoUpdaterResult || $[3] !== isUpdating || $[4] !== onAutoUpdaterResult || $[5] !== onChangeIsUpdating || $[6] !== showSuccessMessage || $[7] !== verbose || $[8] !== withSeparator) {
      t3 = <PackageManagerAutoUpdater verbose={verbose} onAutoUpdaterResult={onAutoUpdaterResult} autoUpdaterResult={autoUpdaterResult} isUpdating={isUpdating} onChangeIsUpdating={onChangeIsUpdating} showSuccessMessage={showSuccessMessage} withSeparator={withSeparator} />;
      $[2] = autoUpdaterResult;
      $[3] = isUpdating;
      $[4] = onAutoUpdaterResult;
      $[5] = onChangeIsUpdating;
      $[6] = showSuccessMessage;
      $[7] = verbose;
      $[8] = withSeparator;
      $[9] = t3;
    } else {
      t3 = $[9];
    }
    return t3;
  }
  const Updater = useNativeInstaller ? NativeAutoUpdater : AutoUpdater;
  let t3;
  if ($[10] !== Updater || $[11] !== autoUpdaterResult || $[12] !== isUpdating || $[13] !== onAutoUpdaterResult || $[14] !== onChangeIsUpdating || $[15] !== showSuccessMessage || $[16] !== verbose || $[17] !== withSeparator) {
    t3 = <Updater verbose={verbose} onAutoUpdaterResult={onAutoUpdaterResult} autoUpdaterResult={autoUpdaterResult} isUpdating={isUpdating} onChangeIsUpdating={onChangeIsUpdating} showSuccessMessage={showSuccessMessage} withSeparator={withSeparator} />;
    $[10] = Updater;
    $[11] = autoUpdaterResult;
    $[12] = isUpdating;
    $[13] = onAutoUpdaterResult;
    $[14] = onChangeIsUpdating;
    $[15] = showSuccessMessage;
    $[16] = verbose;
    $[17] = withSeparator;
    $[18] = t3;
  } else {
    t3 = $[18];
  }
  return t3;
}
