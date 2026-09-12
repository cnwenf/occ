import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useEffect } from 'react';
import { useNotifications } from 'src/context/notifications.js';
import { getIsRemoteMode } from '../../bootstrap/state.js';
import { Text } from '../../ink.js';
import { hasClaudeAiMcpEverConnected, isClaudeAiMcpCurrentlyConnected } from '../../services/mcp/claudeai.js';
import type { MCPServerConnection } from '../../services/mcp/types.js';
import {
  countNeedsAuthToAnnounce,
  countNoticedServersNowConnected,
  markNeedsAuthNoticed,
  type NeedsAuthNoticeDeps,
  pruneNoticedServersNowConnected,
} from '../../utils/mcpNeedsAuthNotice.js';
type Props = {
  mcpClients?: MCPServerConnection[];
};
const EMPTY_MCP_CLIENTS: MCPServerConnection[] = [];
/**
 * CC 2.1.268 E63: the official `DH` deps object —
 * `DH={hasEverConnected:Ykt,connectedThisSession:Vkt}`, where `Ykt` reads the
 * persisted `claudeAiMcpEverConnected` list and `Vkt` reads the session
 * currently-connected set. OCC exports both predicates from claudeai.ts.
 */
const MCP_NEEDS_AUTH_NOTICE_DEPS: NeedsAuthNoticeDeps = {
  hasEverConnected: hasClaudeAiMcpEverConnected,
  connectedThisSession: isClaudeAiMcpCurrentlyConnected,
};
export function useMcpConnectivityStatus(t0) {
  const $ = _c(4);
  const {
    mcpClients: t1
  } = t0;
  const mcpClients = t1 === undefined ? EMPTY_MCP_CLIENTS : t1;
  const {
    addNotification
  } = useNotifications();
  let t2;
  let t3;
  if ($[0] !== addNotification || $[1] !== mcpClients) {
    t2 = () => {
      if (getIsRemoteMode()) {
        return;
      }
      const failedLocalClients = mcpClients.filter(_temp);
      const failedClaudeAiClients = mcpClients.filter(_temp2);
      // CC 2.1.268 E63: prune persisted "already announced" entries whose
      // server is now connected before counting (official Tee effect:
      // `if(...Zbe===0)return;Yye(clients,$H)` gated by `Qye`>0), so a later
      // auth expiry for that server announces again.
      if (countNoticedServersNowConnected(mcpClients) > 0) {
        pruneNoticedServersNowConnected(mcpClients);
      }
      // CC 2.1.218 #20 + CC 2.1.268 E63: the needs-auth count keeps the #20
      // eligibility filter (official `TEt`, unchanged: disconnected claude.ai
      // connectors with eligible===false and IDE internals are excluded,
      // claude.ai connectors count iff ever connected) but is now gated by
      // the once-per-server dedup (official `Kye`/`net` vs 2.1.267's raw
      // count): servers announced in a previous session are skipped.
      const needsAuthCount = countNeedsAuthToAnnounce(mcpClients, MCP_NEEDS_AUTH_NOTICE_DEPS);
      if (failedLocalClients.length === 0 && failedClaudeAiClients.length === 0 && needsAuthCount === 0) {
        return;
      }
      if (failedLocalClients.length > 0) {
        addNotification({
          key: "mcp-failed",
          jsx: <><Text color="error">{failedLocalClients.length} MCP{" "}{failedLocalClients.length === 1 ? "server" : "servers"} failed</Text><Text dimColor={true}> · /mcp</Text></>,
          priority: "medium"
        });
      }
      if (failedClaudeAiClients.length > 0) {
        addNotification({
          key: "mcp-claudeai-failed",
          jsx: <><Text color="error">{failedClaudeAiClients.length} claude.ai{" "}{failedClaudeAiClients.length === 1 ? "connector" : "connectors"}{" "}unavailable</Text><Text dimColor={true}> · /mcp</Text></>,
          priority: "medium"
        });
      }
      if (needsAuthCount > 0) {
        addNotification({
          key: "mcp-needs-auth",
          jsx: <><Text color="warning">{needsAuthCount} MCP{" "}{needsAuthCount === 1 ? "server needs" : "servers need"}{" "}auth</Text><Text dimColor={true}> · /mcp</Text></>,
          priority: "medium"
        });
        // CC 2.1.268 E63: mark the announced servers as noticed once the
        // notice fires (official `kee` render effect → `zye(clients,DH,…)`):
        // session Set + persisted `mcpNeedsAuthNoticed` capped at 128.
        markNeedsAuthNoticed(mcpClients, MCP_NEEDS_AUTH_NOTICE_DEPS);
      }
    };
    t3 = [addNotification, mcpClients];
    $[0] = addNotification;
    $[1] = mcpClients;
    $[2] = t2;
    $[3] = t3;
  } else {
    t2 = $[2];
    t3 = $[3];
  }
  useEffect(t2, t3);
}
function _temp2(client_0) {
  return client_0.type === "failed" && client_0.config.type === "claudeai-proxy" && hasClaudeAiMcpEverConnected(client_0.name);
}
function _temp(client) {
  return client.type === "failed" && client.config.type !== "sse-ide" && client.config.type !== "ws-ide" && client.config.type !== "claudeai-proxy";
}
