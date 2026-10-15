import type { AutoUpdaterResult } from '../utils/autoUpdater.js';

/**
 * Official v299 (#049) AutoUpdater null guard, extracted as a pure predicate
 * so it is unit-testable without mounting the (network-touching) component.
 *
 * Byte-faithful to the decompiled guard
 * `if(!(x||l||I?.status==="success"&&C&&!!z||I?.status==="no_permissions"||
 * I?.status==="install_failed"))return null;`
 * where x=verbose, l=isUpdating, I=autoUpdaterResult, C=showSuccessMessage,
 * z=updateSemver.
 *
 * OCC adaptation: `status==="notice"` (OCC's notice-only auto-update mode —
 * never auto-installs, surfaces "run `occ update`") also renders. That status
 * does not exist upstream, so it is added as an extra disjunct without
 * altering any official branch.
 */
export function shouldRenderAutoUpdater(args: {
  verbose: boolean;
  isUpdating: boolean;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  updateSemver: string | null;
}): boolean {
  const { verbose, isUpdating, autoUpdaterResult, showSuccessMessage, updateSemver } = args;
  return !!(
    verbose ||
    isUpdating ||
    (autoUpdaterResult?.status === 'success' && showSuccessMessage && !!updateSemver) ||
    autoUpdaterResult?.status === 'notice' ||
    autoUpdaterResult?.status === 'no_permissions' ||
    autoUpdaterResult?.status === 'install_failed'
  );
}
