/**
 * Leaf module for the Monitor tool's name.
 *
 * OCC-138: extracted from MonitorTool.ts to match the repo convention
 * (BashTool/toolName.ts, PowerShellTool/toolName.ts, per-tool constants.ts)
 * and to break an import cycle: MonitorTool.ts → BashTool/bashPermissions.js → …
 * → toolPermission/safetyEvent.ts → MonitorTool.ts. safetyEvent builds a
 * module-scope Set that reads MONITOR_TOOL_NAME; when a test imports
 * MonitorTool first, the cycle re-enters before the const initializes →
 * TDZ ReferenceError. A dependency-free leaf module cannot participate in
 * the cycle.
 */
export const MONITOR_TOOL_NAME = 'Monitor'
