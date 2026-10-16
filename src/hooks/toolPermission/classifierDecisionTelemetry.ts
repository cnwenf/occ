// CC 2.1.301 (occ160 WP-C): official changelog —
//   "Added `classifier_verdict` and `permission_mode` to OpenTelemetry
//    `tool_decision` events, so auto mode classifier decisions can be told
//    apart from permission rules" and
//   "Added `classifier_category` to OpenTelemetry `tool_decision` events,
//    naming the built-in rule a classifier block matched, when
//    `OTEL_LOG_TOOL_DETAILS=1`".
//
// Byte-faithful port of the official 2.1.301 linux-x64 ELF helpers that build
// the new tool_decision fields. Offsets are into
// /tmp/cc-diff-301/v301/package/claude (never executed; strings-recovered):
//
//   u9e (@227797100)      — classifier_verdict / classifier_category builder:
//     function u9e(e,n){if(n?.type!=="classifier"||n.classifier!=="auto-mode")
//       return;if(e==="accept")return n.classifierAllowed===!0?
//       {classifier_verdict:"allow"}:void 0;let r=H3n(n);if(r!=="block")
//       return{classifier_verdict:r};let s=Zfe(n.category);
//       return{classifier_verdict:"block",...s!==void 0&&Tc()&&
//       {classifier_category:s}}}
//   H3n (@216936555)      — verdict derivation:
//     function H3n(e){if(e.reason===WWe||e.reason===I3n)return"unavailable";
//       return e.noVerdict?"no_verdict":"block"}
//     WWe="Classifier unavailable" (@216936011 — OCC:
//       CLASSIFIER_UNAVAILABLE_REASON, byte-identical)
//     I3n="Auto mode unavailable — stopped after repeated responses with
//       no safety verdict" (@216936040)
//   Zfe + xAo (@226411221) — built-in category validation:
//     var xAo=new Set([...Fko,...Uko]);
//     function Zfe(e){return e!==void 0&&xAo.has(e)?Pn(e):void 0}
//     Fko (@221513485) = 73 auto-mode rule categories, Uko (@221515279) = 6
//     cowork rule categories. (Pn (@216272311) is the official telemetry
//     string-attribute wrapper `Pn(n){return r(n)}`; OCC's logOTelEvent takes
//     plain strings, so the wrapper is identity here.)
//   Tc (@220028587)       — `function Tc(){return a.OTEL_LOG_TOOL_DETAILS}`
//     where `a` is the boolean-parsed env schema (@217177501: OTEL_LOG_TOOL_
//     DETAILS is in the boolean-parsed set). PRE-EXISTING in 2.1.300 (`jc`
//     @219358485); OCC equivalent: isToolDetailsLoggingEnabled()
//     (isEnvTruthy(process.env.OTEL_LOG_TOOL_DETAILS)) — same semantics.
//   Fl/Ft/Kl (@217201653) — permission-mode → external telemetry label:
//     Kl maps default/plan/acceptEdits/bypassPermissions/dontAsk/auto each to
//     `external:<same name>`; `Ft(e){return Kl[e]??Kl.default}`,
//     `Fl(e){return Ft(e).external}` — unknown modes (incl. OCC-internal
//     'bubble') fall back to "default".
//
// 2.1.300 baseline (/tmp/cc-diff-301/v300/package/claude): `classifier_
// category` has 0 hits; both tool_decision emit sites (Qds @226891992,
// dispatch fallback @227307285) carry neither the classifier fields nor
// permission_mode. The 301 delta at each site is exactly `...be` (u9e) plus
// `permission_mode:Fl(...)`.
//
// Both official emit sites consume this builder:
//   Pfs  (@227800703): be=V==="config"?u9e(K,n.decisionReason):void 0
//   fallback (@228218908): ...Qr==="config"&&So.behavior!=="ask"&&
//     u9e(ss,So.decisionReason)
// — the gate differences live at the call sites (permissionLogging.ts /
// toolExecution.ts), not here.

import { isToolDetailsLoggingEnabled } from '../../services/analytics/metadata.js'
import {
  EXTERNAL_PERMISSION_MODES,
  type PermissionDecisionReason,
  type PermissionMode,
} from '../../types/permissions.js'
import { CLASSIFIER_UNAVAILABLE_REASON } from '../../utils/messages.js'

/**
 * Official I3n (@216936040), verbatim: the reason string on the auto-mode
 * "stopped after repeated no-verdict responses" unavailable denial. H3n
 * compares `decisionReason.reason` against this literal.
 *
 * NOTE: OCC's current denial-limit path (handleDenialLimitExceeded in
 * src/utils/permissions/permissions.ts) returns an `ask` with a synthesized
 * warning string instead, so this branch is dormant in OCC until that flow
 * aligns. The official literal is kept verbatim (never invent) so the port
 * activates automatically when an OCC deny carries it.
 */
const AUTO_MODE_STOPPED_NO_VERDICT_REASON =
  'Auto mode unavailable — stopped after repeated responses with no safety verdict'

/** Official Fko (@221513485) — the 73 built-in auto-mode rule categories, verbatim. */
const AUTO_MODE_RULE_CATEGORIES = [
  'account_standing_rule_changes',
  'auto_mode_bypass',
  'blind_apply',
  'browser_file_upload_exfil',
  'browser_input_exfil',
  'browser_js_exfil',
  'browser_navigate_exfil',
  'browser_shortcut_execution',
  'chatops_trigger_comments',
  'ci_bypass',
  'cloud_storage_mass_delete',
  'cluster_wide_workload_creation',
  'code_from_external',
  'code_that_leaks_when_run',
  'command_network_lists',
  'containment_escape',
  'create_public_surface',
  'create_rce_surface',
  'create_unsafe_agents',
  'credential_exploration',
  'credential_leakage',
  'credential_materialization',
  'data_exfiltration',
  'dns_domain_cert_changes',
  'excess_sensitive_detail',
  'exfil_scouting',
  'expose_local_services',
  'external_ingress_tunnel',
  'external_system_writes',
  'feature_flag_writes',
  'git_destructive',
  'instruction_poisoning',
  'interfere_with_workloads',
  'irreversible_deletion_general',
  'irreversible_local_destruction',
  'live_shared_artifact_sensitive_delta',
  'logging_audit_tampering',
  'merge_without_review',
  'modify_shared_resources',
  'node_lifecycle_operations',
  'out_of_place_publication',
  'package_registry_bypass',
  'permission_grant',
  'pii_data_handling',
  'production_deploy',
  'production_reads',
  'protected_scope_iac_apply',
  'public_data_sharing_upload',
  'real_world_transactions',
  'remote_repoint',
  'remote_shell_writes',
  'safety_bypass_flag',
  'sandbox_network_callback',
  'secret_store_writes',
  'security_test_removal',
  'security_weaken',
  'self_approval',
  'self_modification',
  'sensitive_remote_exec',
  'sensitive_source_provenance',
  'session_transcript_tampering',
  'shared_cluster_mutation',
  'shared_scratch_sweep',
  'third_party_attack',
  'tls_auth_weaken',
  'tmux_self_drive',
  'traffic_redirection',
  'unauthorized_persistence',
  'unrequested_artifact_publish',
  'unrequested_commit_in_a_connected_app',
  'untrusted_code_integration',
  'unverifiable_deletion_scope',
  'unverifiable_deletion_target',
] as const

/** Official Uko (@221515279) — the 6 built-in cowork rule categories, verbatim. */
const COWORK_RULE_CATEGORIES = [
  'cowork_delete_grant',
  'cowork_folder_access',
  'cowork_run_routine_now',
  'cowork_scheduled_task_delete',
  'cowork_scheduled_task_write',
  'cowork_skill_persistence',
] as const

/** Official xAo (@226411221): `new Set([...Fko,...Uko])` — 79 built-in categories. */
const BUILTIN_CLASSIFIER_CATEGORIES: ReadonlySet<string> = new Set([
  ...AUTO_MODE_RULE_CATEGORIES,
  ...COWORK_RULE_CATEGORIES,
])

type ClassifierDecisionReason = Extract<
  PermissionDecisionReason,
  { type: 'classifier' }
>

/**
 * The official classifier decisionReason on an auto-mode ALLOW carries
 * `classifierAllowed:!0`, stamped by the official allow-through-classifier
 * path (`Mt`, @~229058944: `decisionReason:{...yd.decisionReason,
 * classifierAllowed:!0}` when `noVerdict!==!0&&classifierRan!==!1`).
 *
 * OCC's PermissionDecisionReason (src/types/permissions.ts — outside this
 * WP's file cluster) has no `classifierAllowed` field yet and OCC's
 * classifier allow path never stamps it, so the accept branch below is
 * structurally faithful but dormant until the stamping site is ported.
 * Read it through a narrowed structural type rather than widening the
 * cross-file union from here.
 */
type ClassifierReasonWithAllowed = ClassifierDecisionReason & {
  classifierAllowed?: boolean
}

/**
 * Official Zfe (@226411221): a category is telemetry-reported only when it
 * names one of the built-in classifier rules (xAo membership); anything else
 * (undefined, or an out-of-set value such as OCC's stale coarse 2.1.200
 * taxonomy 'behavioral_risk'/'information_exposure'/'high_impact_operation'
 * — absent from BOTH the 300 and 301 binaries) yields undefined and the
 * classifier_category attribute is omitted.
 */
function sanitizeClassifierCategory(
  category: string | undefined,
): string | undefined {
  return category !== undefined && BUILTIN_CLASSIFIER_CATEGORIES.has(category)
    ? category
    : undefined
}

/** Official H3n (@216936555) — the non-accept classifier verdict. */
function classifierVerdictForReason(
  reason: ClassifierDecisionReason,
): 'unavailable' | 'no_verdict' | 'block' {
  if (
    reason.reason === CLASSIFIER_UNAVAILABLE_REASON ||
    reason.reason === AUTO_MODE_STOPPED_NO_VERDICT_REASON
  ) {
    return 'unavailable'
  }
  return reason.noVerdict ? 'no_verdict' : 'block'
}

/**
 * Official u9e (@227797100) — builds the 2.1.301 classifier attributes for a
 * tool_decision event. Returns undefined (no attributes) unless the decision
 * reason is an auto-mode classifier verdict:
 *
 * - accept: `{classifier_verdict:"allow"}` only when the official
 *   `classifierAllowed===true` stamp is present (see ClassifierReasonWith
 *   Allowed); otherwise undefined.
 * - unavailable / no_verdict reasons: `{classifier_verdict:<verdict>}`.
 * - block: `{classifier_verdict:"block"}` plus `classifier_category` ONLY
 *   when the category names a built-in rule (Zfe) AND OTEL_LOG_TOOL_DETAILS
 *   is truthy (Tc @220028587 — the gate applies to classifier_category
 *   alone; classifier_verdict is ungated).
 *
 * The `decision` parameter is the final OTel label ('accept' | 'reject' |
 * 'abort'); the official compares `e==="accept"` and every other label takes
 * the verdict branch (OCC's CC 2.1.216 #29 'abort' label can never pair with
 * a config source, so it cannot reach here in practice).
 */
export function buildClassifierToolDecisionFields(
  decision: 'accept' | 'reject' | 'abort',
  decisionReason: PermissionDecisionReason | undefined,
): Record<string, string> | undefined {
  if (
    decisionReason?.type !== 'classifier' ||
    decisionReason.classifier !== 'auto-mode'
  ) {
    return undefined
  }
  if (decision === 'accept') {
    return (decisionReason as ClassifierReasonWithAllowed).classifierAllowed ===
      true
      ? { classifier_verdict: 'allow' }
      : undefined
  }
  const verdict = classifierVerdictForReason(decisionReason)
  if (verdict !== 'block') {
    return { classifier_verdict: verdict }
  }
  const category = sanitizeClassifierCategory(decisionReason.category)
  return {
    classifier_verdict: 'block',
    // Official: `...s!==void 0&&Tc()&&{classifier_category:s}`.
    ...(category !== undefined &&
      isToolDetailsLoggingEnabled() && { classifier_category: category }),
  }
}

/**
 * Official Fl (@217201653): `Fl(e){return Ft(e).external}` with
 * `Ft(e){return Kl[e]??Kl.default}` — every user-addressable mode maps to
 * its own name in the Kl table's `external` column; anything else (OCC's
 * internal 'bubble', undefined) falls back to "default".
 */
export function permissionModeToExternal(
  mode: PermissionMode | undefined,
): string {
  return mode !== undefined &&
    (EXTERNAL_PERMISSION_MODES as readonly string[]).includes(mode)
    ? mode
    : 'default'
}
