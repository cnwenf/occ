// Auto-generated stub — replace with real implementation
//
// CC 2.1.282 reserved-namespace hardening (official j.fetchForClient boundary
// gate, byte-exact): when the plaid-harbor gate is on and the MCP server name
// (normalized) sits in the reserved anthropic-skills / claude-ai namespace, no
// skills load from that server — the exact skills-funnel message goes to the
// MCP debug log and the result is []. Tools are unaffected. Keeping the gate
// on the stub preserves the boundary behavior for when the stub is replaced.
export {};
import type { Command } from 'src/types/command.js';
import { normalizeNameForMCP } from 'src/services/mcp/normalization.js';
import { logMCPDebug } from 'src/utils/log.js';
import {
  isReservedMcpServerName,
  reservedMcpServerSkillsMessage,
} from 'src/utils/skills/reservedNames.js';
export const fetchMcpSkillsForClient: ((...args: unknown[]) => Promise<Command[]>) & { cache: Map<string, unknown> } = Object.assign(
  (...args: unknown[]) => {
    const serverName = (args[0] as { name?: unknown } | undefined)?.name;
    if (typeof serverName === 'string') {
      const normalized = normalizeNameForMCP(serverName);
      if (isReservedMcpServerName(normalized)) {
        logMCPDebug(serverName, reservedMcpServerSkillsMessage(normalized));
      }
    }
    return Promise.resolve([] as Command[]);
  },
  { cache: new Map<string, unknown>() }
);
