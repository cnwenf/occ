import { logForDebugging } from '../debug.js'
import { getMdmSettings } from '../settings/mdm/settings.js'
import {
  getPolicySettingsOrigin,
  getSettingsForSource,
  loadManagedFileSettings,
} from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'

/**
 * CC 2.1.295 (#073) — official fix: "Fixed a tampered cache of
 * server-managed settings making a person's own plugin count as
 * organization-managed on machines whose managed settings list or enable
 * plugins."
 *
 * Official machinery (s295 binary forensics): managed-plugin provenance now
 * reads a VOUCHED admin tier — `x()` returns the cached vouched tier when
 * `L(e)=S(e)||Dvo()` holds, where `Dvo()` (machinePluginKeyLoadRecords) is
 * true only when an admin load record is `userWritable!==!0 &&
 * wslIgnored!==!0`. Plugin keys coming from "managed settings this session
 * does not vouch for (such as remote managed settings the server has not
 * confirmed this session, or a document your user account can write)" are
 * "not treated as the organization's" (const `v` + warn templates, all NEW
 * in 295 — 0 hits in s294; s294's `eU()` read raw policySettings with no
 * vouching gate, which is the fixed bug).
 *
 * OCC face: the policySettings cascade (settings.ts, first-source-wins) puts
 * the plain-JSON `~/.claude/remote-settings.json` disk cache at the TOP arm.
 * OCC has no remote server-confirmation subsystem (documented divergence —
 * allowedProvidersEnforcement.ts: isRemotePolicyVerified → false), so the
 * remote arm is NEVER vouched in OCC ("remote managed settings the server
 * has not confirmed this session"); HKCU is user-writable ("a document your
 * user account can write"). The machine's own admin-only arms — MDM
 * (plist/HKLM) and managed-settings.json — are vouched. A tampered remote
 * cache therefore can no longer make a personal plugin count as
 * org-managed; the machine's own vouched settings still do (the changelog's
 * "machines whose managed settings list or enable plugins" case).
 */
const VOUCHED_POLICY_ORIGINS = new Set<string>(['plist', 'hklm', 'file'])

/**
 * Resolve the enabledPlugins record from settings the session vouches for.
 * Official fallback semantics: when the winning policySettings arm is not
 * vouched, its plugin keys are not treated as the organization's — the
 * machine's own vouched arms (MDM, then managed-settings.json, mirroring the
 * cascade priority minus the two unvouched arms) still count.
 */
function getVouchedEnabledPlugins(): SettingsJson['enabledPlugins'] {
  const origin = getPolicySettingsOrigin()
  if (origin !== null && !VOUCHED_POLICY_ORIGINS.has(origin)) {
    const unvouched = getSettingsForSource('policySettings')?.enabledPlugins
    if (unvouched && Object.keys(unvouched).length > 0) {
      // Official warn template (adapted): "…is enabled only by managed
      // settings this session does not vouch for…so it is not treated as
      // the organization's…It can be seated only once managed settings the
      // session vouches for enable it: this machine's own, or remote managed
      // settings once the server confirms them."
      const reason =
        origin === 'remote'
          ? 'remote managed settings the server has not confirmed this session'
          : 'a document your user account can write'
      logForDebugging(
        `[plugins] enabledPlugins in ${origin} managed settings are not treated as the organization's: this session does not vouch for that source (${reason}). They can be seated only once managed settings the session vouches for enable them: this machine's own, or remote managed settings once the server confirms them.`,
        { level: 'warn' },
      )
    }
    const mdm = getMdmSettings().settings
    if (mdm.enabledPlugins) {
      return mdm.enabledPlugins
    }
    return loadManagedFileSettings().settings?.enabledPlugins
  }
  return getSettingsForSource('policySettings')?.enabledPlugins
}

/**
 * Plugin names locked by org policy (policySettings.enabledPlugins).
 *
 * CC 2.1.295 (#073): only enabledPlugins from managed settings the session
 * vouches for count (see getVouchedEnabledPlugins).
 *
 * Returns null when managed settings declare no plugin entries (common
 * case — no policy in effect).
 */
export function getManagedPluginNames(): Set<string> | null {
  const enabledPlugins = getVouchedEnabledPlugins()
  if (!enabledPlugins) {
    return null
  }
  const names = new Set<string>()
  for (const [pluginId, value] of Object.entries(enabledPlugins)) {
    // Only plugin@marketplace boolean entries (true OR false) are
    // protected. Legacy owner/repo array form is not.
    if (typeof value !== 'boolean' || !pluginId.includes('@')) {
      continue
    }
    const name = pluginId.split('@')[0]
    if (name) {
      names.add(name)
    }
  }
  return names.size > 0 ? names : null
}
