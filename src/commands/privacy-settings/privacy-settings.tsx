import * as React from 'react';
import { type GroveDecision, GroveDialog, PrivacySettingsDialog } from '../../components/grove/Grove.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { getGroveNoticeConfig, getGroveSettings, isQualifiedForGrove } from '../../services/api/grove.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
// Official 2.1.309 item 24 (F-9, BIN309 `p`/`d` @284071377, byte-verified):
// `p` (FALLBACK_MESSAGE) stays for the not-qualified case; `d`
// (CANNOT_FETCH_MESSAGE) is NEW in 309 and replaces both the old fallback on
// fetch failure and OCC's drifted 'Unable to retrieve updated privacy
// settings' on the post-toggle refetch failure.
const FALLBACK_MESSAGE = 'Review and manage your privacy settings at https://claude.ai/settings/data-privacy-controls';
const CANNOT_FETCH_MESSAGE = 'Unable to fetch your privacy settings at this time. Check https://claude.ai/settings/data-privacy-controls';
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode | null> {
  const qualified = await isQualifiedForGrove();
  if (!qualified) {
    onDone(FALLBACK_MESSAGE);
    return null;
  }
  // Official 2.1.309 item 24 (`Iee.cache.clear?.()` before the fetch pair):
  // drop the session-memoized grove settings so the dialog never renders a
  // stale value from earlier in the session. grove.ts keeps its memoize (the
  // official keeps it too — invalidation lives here in the command). The
  // extra `?.` on `.cache` vs the official's direct access is null-safety
  // for module mocks only; lodash memoize always provides it.
  getGroveSettings.cache?.clear?.();
  const [settingsResult, configResult] = await Promise.all([getGroveSettings(), getGroveNoticeConfig()]);
  // Hide dialog on API failure (after retry).
  // Official 2.1.304 #28: BOTH fetches must succeed — a failed config fetch
  // used to fall through and render the dialog with domainExcluded unknown.
  // Official 2.1.309 item 24: the failure message is now `d`, not `p`.
  if (!settingsResult.success || !configResult.success) {
    onDone(CANNOT_FETCH_MESSAGE);
    return null;
  }
  const settings = settingsResult.data;
  const config = configResult.data;
  async function onDoneWithDecision(decision: GroveDecision) {
    if (decision === 'escape' || decision === 'defer') {
      onDone('Privacy settings dialog dismissed', {
        display: 'system'
      });
      return;
    }
    await onDoneWithSettingsCheck();
  }
  async function onDoneWithSettingsCheck() {
    const updatedSettingsResult = await getGroveSettings();
    if (!updatedSettingsResult.success) {
      // Official 2.1.309 item 24 (`t(d,{display:"system"})` in `c()`).
      onDone(CANNOT_FETCH_MESSAGE, {
        display: 'system'
      });
      return;
    }
    const updatedSettings = updatedSettingsResult.data;
    const groveStatus = updatedSettings.grove_enabled ? 'true' : 'false';
    // Official string (present in BOTH BIN308 and BIN309 — OCC had drifted to
    // "Help improve Claude"): `"Help improve our AI models" set to ${m}.`
    onDone(`"Help improve our AI models" set to ${groveStatus}.`);
    if (settings.grove_enabled !== null && settings.grove_enabled !== updatedSettings.grove_enabled) {
      logEvent('tengu_grove_policy_toggled', {
        state: updatedSettings.grove_enabled as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        location: 'settings' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
    }
  }

  // Show privacy settings directly if the user has already accepted the
  // terms.
  if (settings.grove_enabled !== null) {
    return <PrivacySettingsDialog settings={settings} domainExcluded={config.domain_excluded} onDone={onDoneWithSettingsCheck}></PrivacySettingsDialog>;
  }

  // Show the GroveDialog for users who haven't accepted terms yet
  return <GroveDialog showIfAlreadyViewed={true} onDone={onDoneWithDecision} location={'settings'} />;
}
