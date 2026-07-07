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
  // 2.1.200: tools that ship live in the official default registry.
  //   MONITOR_TOOL  -> MonitorTool (H1)
  //   KAIROS        -> PushNotificationTool (H2). (SleepTool/SendUserFileTool
  //                   are .js stubs whose `undefined` export is filtered out of
  //                   getAllBaseTools via the `...(T ? [T] : [])` spread, so
  //                   only PushNotificationTool actually enters the registry.)
  //   UDS_INBOX     -> ListPeersTool, exposed as "ListAgents" (H3)
  'MONITOR_TOOL',
  'KAIROS',
  'UDS_INBOX',
])
export const feature = (name: string): boolean => FEATURE_ALLOWLIST.has(name)
