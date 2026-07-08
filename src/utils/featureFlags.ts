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
])
export const feature = (name: string): boolean => FEATURE_ALLOWLIST.has(name)
