/**
 * OCC runtime feature flags. Replaces `import { feature } from 'src/utils/featureFlags.js'`
 * — bun:bundle's feature() is a build-time macro that returns false for all
 * flags in the external build, which dead-code-eliminates flagged branches
 * (e.g. the entire auto-mode classifier). This runtime module keeps the
 * flagged code in the bundle and returns true for the allowlist, so auto mode
 * (TRANSCRIPT_CLASSIFIER) is selectable + functional.
 *
 * The allowlist enables the auto-mode features to match the official external
 * build, which includes the auto-mode code and gates it at runtime via Statsig.
 */
const FEATURE_ALLOWLIST: Set<string> = new Set([
  'TRANSCRIPT_CLASSIFIER',
  'BASH_CLASSIFIER',
])
export const feature = (name: string): boolean => FEATURE_ALLOWLIST.has(name)
