/**
 * Feature flags. In the official claude-code build these come from bun:bundle
 * (build-time). In OCC, feature() returns true iff the flag is in this
 * allowlist — a runtime stand-in for the build-time gate.
 *
 * Most flags stay OFF (they gate subsystems OCC deliberately trims: PROACTIVE,
 * KAIROS, UDS_INBOX, etc.). Adding a flag here reactivates that subsystem at
 * runtime — only do so once the subsystem's init is non-blocking in OCC's
 * trimmed build. (KAIROS reactivates BriefTool's 5-min refresh loop + assistant
 * + SendUserFile; UDS_INBOX reactivates ListPeers' session-registry scan —
 * both hang the query path when enabled. MONITOR_TOOL is self-contained + safe.)
 */
const FEATURE_ALLOWLIST: Set<string> = new Set([
  'TRANSCRIPT_CLASSIFIER',
  'BASH_CLASSIFIER',
  // 2.1.200: Monitor tool ships live (self-contained, no blocking init).
  'MONITOR_TOOL',
  // 2.1.154: Workflow engine — vm-sandboxed multi-agent workflow scripts.
  // Self-contained (vm + runAgent reuse), no blocking init. Un-gates the
  // Workflow tool (src/tools.ts) + /workflows command + getWorkflowCommands
  // (src/commands.ts) in one switch.
  'WORKFLOW_SCRIPTS',
  // 2.1.200: Skill discovery (turn-zero). Un-gates skill prefetch in
  // src/query.ts, DiscoverSkills in SkillTool, the /skills clear-cache hook
  // in commands.ts, attachment + compact skill paths, and the skill-search
  // prompt sections. The prefetch + localSearch modules are self-contained
  // (filesystem index + in-memory cache); enabling them does not block the
  // query path.
  'EXPERIMENTAL_SKILL_SEARCH',
  // 2.1.200: MCP skills — fetches skill modules exposed by MCP servers that
  // declare the io.modelcontextprotocol/skills extension. Wired through
  // src/services/mcp/client.ts + useManageMCPConnections.ts; runs only when
  // an MCP server is connected, so it is non-blocking when no MCP server is
  // present.
  'MCP_SKILLS',
  // 2.1.208: Screen reader mode (accessibility subsystem). Gates the SR
  // feature gate `tengu_ax_screen_reader` read by the toggle in
  // src/utils/screenReader.ts. This is a SHIPPING accessibility subsystem
  // with no blocking init (no KAIROS-style loop, no UDS_INBOX scan) — enabling
  // it only un-gates the SR toggle's feature-gate default. The official
  // feature("tengu_ax_screen_reader", true) returns true | undefined and
  // `?? true` defaults ON when unregistered; OCC's feature() returns boolean
  // (false when unregistered), so membership here is what makes
  // `feature('tengu_ax_screen_reader') ?? true` evaluate to `true` instead of
  // `false` (false is not nullish → would permanently disable SR). Safe —
  // hang-smoke verified.
  'tengu_ax_screen_reader',
  // 2.1.212: MCP tool auto-background. Upstream gates the default-on
  // threshold via feature("tengu_mcp_auto_background", true) — the second
  // arg is the default-true, so the 120000ms auto-background is ON by
  // default. OCC's feature() returns boolean (false when unregistered), so
  // membership here is what makes the default 120000ms threshold active.
  // The env overrides (CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS,
  // CLAUDE_AUTO_BACKGROUND_TASKS) work regardless of this flag. Safe —
  // the auto-background primitive is self-contained and only wraps the MCP
  // tool-call dispatch site.
  'tengu_mcp_auto_background',
])
export const feature = (name: string): boolean => FEATURE_ALLOWLIST.has(name)
