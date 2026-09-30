/**
 * MCP subcommand handlers — extracted from main.tsx for lazy loading.
 * These are dynamically imported only when the corresponding `claude mcp *` command runs.
 */

import { stat } from 'fs/promises';
import pMap from 'p-map';
import { cwd } from 'process';
import readline from 'node:readline';
import React from 'react';
import { MCPServerDesktopImportDialog } from '../../components/MCPServerDesktopImportDialog.js';
import { render } from '../../ink.js';
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { clearMcpClientConfig, clearServerTokensFromLocalStorage, getMcpClientConfig, performMCPOAuthFlow, readClientSecret, revokeServerTokens, saveMcpClientSecret } from '../../services/mcp/auth.js';
import { connectToServer, getMcpServerConnectionBatchSize, removeMcpAuthCacheEntry } from '../../services/mcp/client.js';
import { addMcpConfig, getAllMcpConfigs, getMcpConfigByName, getMcpConfigsByScope, removeMcpConfig } from '../../services/mcp/config.js';
import type { ConfigScope, ScopedMcpServerConfig } from '../../services/mcp/types.js';
import { mcpServerNotFoundMessage, mcpServerNotFoundMessageWithPending, sanitizeMcpCliText } from '../../services/mcp/cliMessages.js';
import { getDisplayConfig, getDisplayServers, redactMcpErrorDetail, sanitizeConfigForDisplay } from '../../services/mcp/redaction.js';
import { describeMcpConfigFilePath, ensureConfigScope, getScopeLabel, mcpServerHealthStatusLabel, getMcpServerFailureMessage, getProjectMcpServerStatus, isStdioConfig, MCP_FILE_BACKED_SCOPES, resolveUnexpandedMcpServers } from '../../services/mcp/utils.js';
import { partitionMcpServersByName } from '../../services/mcp/normalization.js';
import { AppStateProvider } from '../../state/AppState.js';
import { getCurrentProjectConfig, getGlobalConfig, saveCurrentProjectConfig } from '../../utils/config.js';
import { logForDebugging } from '../../utils/debug.js';
import { errorMessage, isFsInaccessible } from '../../utils/errors.js';
import { gracefulShutdown } from '../../utils/gracefulShutdown.js';
import { safeParseJSON } from '../../utils/json.js';
import { getPlatform } from '../../utils/platform.js';
import { writeToStderr } from '../../utils/process.js';
import { cliError, cliOk } from '../exit.js';
import { promptForCallbackUrlWithRetry } from '../mcpOAuthPrompt.js';
async function checkMcpServerHealth(name: string, server: ScopedMcpServerConfig): Promise<string> {
  try {
    const result = await connectToServer(name, server);
    // CC 2.1.218 #5: surface the binary's exact health-check status label
    // (✓ Connected / ! Needs authentication / - Not configured / ✗ Failed
    // to connect / … Connecting / pending approval / ◯ Disabled) instead of
    // the inline branch above, which only distinguished three states and
    // never rendered the UNCONFIGURED (- Not configured) variant.
    const label = mcpServerHealthStatusLabel(result);
    // For a failed server, append the human-readable failure detail (HTTP
    // status + error text) so `claude mcp list` / `claude mcp get` show WHY
    // the connection failed, not just that it did. Mirrors the binary's `TQo`
    // detail surfaced alongside the `whp` status label.
    if (result.type === 'failed') {
      const detail = getMcpServerFailureMessage(result);
      if (detail) {
        return `${label} — ${detail}`;
      }
    }
    return label;
  } catch (_error) {
    return '✗ Connection error';
  }
}

/**
 * CC 2.1.285 (item 8): the official v285 get/login/logout not-found call sites
 * pass `r.size>0` to `u2t`, where `r` = the project (.mcp.json) servers still
 * pending trust approval. Same primitives OCC already uses elsewhere
 * (`getMcpConfigsByScope('project')` + `getProjectMcpServerStatus`).
 */
function hasPendingProjectMcpServers(): boolean {
  const {
    servers
  } = getMcpConfigsByScope('project');
  return Object.keys(servers).some(serverName => getProjectMcpServerStatus(serverName) === 'pending');
}

// mcp serve (lines 4512–4532)
export async function mcpServeHandler({
  debug,
  verbose
}: {
  debug?: boolean;
  verbose?: boolean;
}): Promise<void> {
  const providedCwd = cwd();
  logEvent('tengu_mcp_start', {});
  try {
    await stat(providedCwd);
  } catch (error) {
    if (isFsInaccessible(error)) {
      cliError(`Error: Directory ${providedCwd} does not exist`);
    }
    throw error;
  }
  try {
    const {
      setup
    } = await import('../../setup.js');
    await setup(providedCwd, 'default', false, false, undefined, false);
    const {
      startMCPServer
    } = await import('../../entrypoints/mcp.js');
    await startMCPServer(providedCwd, debug ?? false, verbose ?? false);
  } catch (error) {
    cliError(`Error: Failed to start MCP server: ${error}`);
  }
}

// mcp remove (lines 4545–4635)
export async function mcpRemoveHandler(name: string, options: {
  scope?: string;
}): Promise<void> {
  // Look up config before removing so we can clean up secure storage
  const serverBeforeRemoval = getMcpConfigByName(name);
  // claude-code 2.1.280 (#048): "Fixed an MCP server re-added under the same
  // name after `claude mcp remove` still showing as needing authentication
  // instead of reconnecting." The needs-auth cache entry is dropped
  // UNCONDITIONALLY and BEFORE the sse/http gate — a stdio server never wrote
  // one, but the removal must not be conditioned on the config we are deleting
  // being remote (and a stale entry under a reused name must not survive).
  // Byte-verified official handler (2.1.280 ELF @219311718):
  //   m=async()=>{if(await me().removeMcpAuthCacheEntry(o,p),
  //       a&&(a.type==="sse"||a.type==="http"))
  //     try{await V().clearServerTokensFromLocalStorage(o,a),
  //         await V().clearMcpClientConfig(o,a)}
  //     catch(j){t(`mcp remove: secure-storage cleanup for "${o}" failed: ${l(j)}`,
  //                {level:"warn"})}}
  // awaited as `await m()` after each successful `removeMcpConfig`. The
  // warn-log catch is byte-identical in 2.1.278 (@220132743) — OCC lacked it,
  // so a secure-storage throw used to abort `mcp remove` after the config was
  // already gone; it now only warns.
  const cleanupSecureStorage = async () => {
    await removeMcpAuthCacheEntry(name);
    if (serverBeforeRemoval && (serverBeforeRemoval.type === 'sse' || serverBeforeRemoval.type === 'http')) {
      try {
        clearServerTokensFromLocalStorage(name, serverBeforeRemoval);
        clearMcpClientConfig(name, serverBeforeRemoval);
      } catch (error) {
        logForDebugging(`mcp remove: secure-storage cleanup for "${name}" failed: ${errorMessage(error)}`, { level: 'warn' });
      }
    }
  };
  try {
    if (options.scope) {
      const scope = ensureConfigScope(options.scope);
      logEvent('tengu_mcp_delete', {
        name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      await removeMcpConfig(name, scope);
      await cleanupSecureStorage();
      process.stdout.write(`Removed MCP server ${name} from ${scope} config\n`);
      cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`);
    }

    // If no scope specified, check where the server exists
    const projectConfig = getCurrentProjectConfig();
    const globalConfig = getGlobalConfig();

    // Check if server exists in project scope (.mcp.json)
    const {
      servers: projectServers
    } = getMcpConfigsByScope('project');
    const mcpJsonExists = !!projectServers[name];

    // Count how many scopes contain this server
    const scopes: Array<Exclude<ConfigScope, 'dynamic'>> = [];
    if (projectConfig.mcpServers?.[name]) scopes.push('local');
    if (mcpJsonExists) scopes.push('project');
    if (globalConfig.mcpServers?.[name]) scopes.push('user');
    if (scopes.length === 0) {
      // CC 2.1.285 (item 8): official v285 remove handler ends in
      // `si(iQn(o,U(M)))` — M = local-config + raw .mcp.json + user-config
      // server names, U dedupes (v284: `Ui(wQn(o,D(R)))`, identical sources
      // and templates; v285 adds the `Tn` sanitization inside the builder).
      // Replaces OCC's drifted `No MCP server found with name: "${name}"`.
      const configuredNames = [...new Set([...Object.keys(projectConfig.mcpServers ?? {}), ...Object.keys(projectServers), ...Object.keys(globalConfig.mcpServers ?? {})])];
      cliError(mcpServerNotFoundMessage(name, configuredNames));
    } else if (scopes.length === 1) {
      // Server exists in only one scope, remove it
      const scope = scopes[0]!;
      logEvent('tengu_mcp_delete', {
        name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      await removeMcpConfig(name, scope);
      await cleanupSecureStorage();
      process.stdout.write(`Removed MCP server "${name}" from ${scope} config\n`);
      cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`);
    } else {
      // Server exists in multiple scopes
      process.stderr.write(`MCP server "${name}" exists in multiple scopes:\n`);
      scopes.forEach(scope => {
        process.stderr.write(`  - ${getScopeLabel(scope)} (${describeMcpConfigFilePath(scope)})\n`);
      });
      process.stderr.write('\nTo remove from a specific scope, use:\n');
      scopes.forEach(scope => {
        process.stderr.write(`  occ mcp remove "${name}" -s ${scope}\n`);
      });
      cliError();
    }
  } catch (error) {
    cliError((error as Error).message);
  }
}

// mcp list (lines 4641–4688)
export async function mcpListHandler(): Promise<void> {
  logEvent('tengu_mcp_list', {});
  const {
    servers: configs
  } = await getAllMcpConfigs();
  if (Object.keys(configs).length === 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('No MCP servers configured. Use `occ mcp add` to add a server.');
  } else {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Checking MCP server health…\n');

    // Check servers concurrently
    const entries = Object.entries(configs);
    const results = await pMap(entries, async ([name, server]) => ({
      name,
      server,
      status: await checkMcpServerHealth(name, server)
    }), {
      concurrency: getMcpServerConnectionBatchSize()
    });
    // CC 2.1.268 E16: print the DISPLAY copies (binary `Be` → `Ne`), which
    // carry the AUTHORED `${VAR}` templates — or a sanitized type-label /
    // [REDACTED] fallback — instead of the expanded configs used for the
    // health checks above. Never print secrets resolved from `${VAR}`.
    const displayConfigs = getDisplayServers(configs, resolveUnexpandedMcpServers);
    for (const {
      name,
      status
    } of results) {
      const server = displayConfigs[name];
      if (!server) continue;
      // CC 2.1.285 (item 7): official v285 row builder `Fe` gained a ws branch
      // (`if(o.type==="ws")return`${f}: ${o.url} (WS) - ${a}`;` — the string
      // "(WS) - " exists only in v285 bytes, @231389086) between the http and
      // claudeai-proxy branches; v284 silently dropped ws servers from
      // `mcp list`. The health checker `Oe` is byte-identical across versions,
      // so this is a renderer-only fix (OCC's connectToServer already speaks
      // ws, so the status above is a real health check).
      // CC 2.1.285 (item 8): v284 rendered `d.map(Fe).filter(Dr)`; v285 is
      // `d.map(Fe).filter(Fr).map(Tn)` — each row passes through the
      // control/format-char sanitizer before printing, so hostile server
      // names/values cannot inject line breaks or ANSI escapes.
      let row: string | null = null;
      // Intentionally excluding sse-ide servers here since they're internal
      if (server.type === 'sse') {
        row = `${name}: ${server.url} (SSE) - ${status}`;
      } else if (server.type === 'http') {
        row = `${name}: ${server.url} (HTTP) - ${status}`;
      } else if (server.type === 'ws') {
        row = `${name}: ${server.url} (WS) - ${status}`;
      } else if (server.type === 'claudeai-proxy') {
        row = `${name}: ${server.url} - ${status}`;
      } else if (!server.type || server.type === 'stdio') {
        const args = Array.isArray((server as any).args) ? (server as any).args : [];
        row = `${name}: ${(server as any).command} ${args.join(' ')} - ${status}`;
      }
      if (row !== null) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(sanitizeMcpCliText(row));
      }
    }
  }
  // Use gracefulShutdown to properly clean up MCP server connections
  // (process.exit bypasses cleanup handlers, leaving child processes orphaned)
  await gracefulShutdown(0);
}

// mcp get (lines 4694–4786)
export async function mcpGetHandler(name: string): Promise<void> {
  logEvent('tengu_mcp_get', {
    name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  const server = getMcpConfigByName(name);
  if (!server) {
    // CC 2.1.285 (item 8): official v285 get handler ends in
    // `si(u2t(t,M,r.size>0))` — M = configured names minus pending/rejected
    // (OCC's getAllMcpConfigs already filters those), r = pending .mcp.json
    // servers. Replaces OCC's drifted `No MCP server found with name: ${name}`.
    const {
      servers
    } = await getAllMcpConfigs();
    return cliError(mcpServerNotFoundMessageWithPending(name, Object.keys(servers), hasPendingProjectMcpServers()));
  }

  // Check server health first — official v285 computes the status, builds the
  // full output block, then renders it in one sanitized pass.
  const status = await checkMcpServerHealth(name, server);
  const lines: string[] = [`${name}:`, `  Scope: ${getScopeLabel(server.scope)}`, `  Status: ${status}`];

  // CC 2.1.268 E16 + CC 2.1.285 (item 5): official v285 display selection —
  //   h=Die(i)&&!OKe.has(i.scope)?Y(i):Ie({[o]:i})[o]??Y(i)
  // A stdio-like server whose scope is NOT file-backed (dynamic =
  // --mcp-config / Agent SDK / plugin) now renders from the SANITIZED copy:
  // command → type label, args → [], env values → [REDACTED] with the
  // variable names still shown. File-backed scopes keep the E16
  // authored-unexpanded path (binary `Ie({[o]:i})[o]??Y(i)`).
  const display = isStdioConfig(server) && !MCP_FILE_BACKED_SCOPES.has(server.scope) ? sanitizeConfigForDisplay(server) : getDisplayConfig(name, server, resolveUnexpandedMcpServers);

  // Intentionally excluding sse-ide servers here since they're internal.
  // CC 2.1.285 (item 6): official v285 merged the sse/http branches into one
  // URL branch and gated the stdio branch on `Die(i)&&Die(h)` — v284 required
  // literal `i.type==="stdio"&&f.type==="stdio"`, so a stdio entry omitting
  // the `type` field printed no Type/Command/Args/Environment at all.
  if ((server.type === 'sse' || server.type === 'http') && (display.type === 'sse' || display.type === 'http')) {
    lines.push(`  Type: ${server.type}`);
    lines.push(`  URL: ${display.url}`);
    if (display.headers) {
      lines.push('  Headers:');
      for (const [key, value] of Object.entries(display.headers)) {
        lines.push(`    ${key}: ${value}`);
      }
    }
    if (server.oauth?.clientId || server.oauth?.callbackPort) {
      const parts: string[] = [];
      if (server.oauth.clientId) {
        parts.push('client_id configured');
        const clientConfig = getMcpClientConfig(name, server);
        if (clientConfig?.clientSecret) parts.push('client_secret configured');
      }
      if (server.oauth.callbackPort) parts.push(`callback_port ${server.oauth.callbackPort}`);
      lines.push(`  OAuth: ${parts.join(', ')}`);
    }
  } else if (isStdioConfig(server) && isStdioConfig(display)) {
    lines.push('  Type: stdio');
    lines.push(`  Command: ${display.command}`);
    const args = Array.isArray(display.args) ? display.args : [];
    lines.push(`  Args: ${args.join(' ')}`);
    if (display.env) {
      lines.push('  Environment:');
      for (const [key, value] of Object.entries(display.env)) {
        lines.push(`    ${key}=${value}`);
      }
    }
  }
  lines.push('', `To remove this server, run: occ mcp remove "${name}" -s ${server.scope}`);
  // CC 2.1.285 (item 8): official v285 renders `R.map(Tn).join("\n")`
  // (v284: `M.join("\n")`) — every line passes through the control/format
  // sanitizer, so hostile names/values cannot inject line breaks or ANSI
  // escape sequences into the terminal.
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(lines.map(sanitizeMcpCliText).join('\n'));
  // Use gracefulShutdown to properly clean up MCP server connections
  // (process.exit bypasses cleanup handlers, leaving child processes orphaned)
  await gracefulShutdown(0);
}

// mcp add-json (lines 4801–4870)
export async function mcpAddJsonHandler(name: string, json: string, options: {
  scope?: string;
  clientSecret?: true;
}): Promise<void> {
  try {
    const scope = ensureConfigScope(options.scope);
    const parsedJson = safeParseJSON(json);

    // Read secret before writing config so cancellation doesn't leave partial state
    const needsSecret = options.clientSecret && parsedJson && typeof parsedJson === 'object' && 'type' in parsedJson && (parsedJson.type === 'sse' || parsedJson.type === 'http') && 'url' in parsedJson && typeof parsedJson.url === 'string' && 'oauth' in parsedJson && parsedJson.oauth && typeof parsedJson.oauth === 'object' && 'clientId' in parsedJson.oauth;
    const clientSecret = needsSecret ? await readClientSecret() : undefined;
    await addMcpConfig(name, parsedJson, scope);
    const transportType = parsedJson && typeof parsedJson === 'object' && 'type' in parsedJson ? String(parsedJson.type || 'stdio') : 'stdio';
    if (clientSecret && parsedJson && typeof parsedJson === 'object' && 'type' in parsedJson && (parsedJson.type === 'sse' || parsedJson.type === 'http') && 'url' in parsedJson && typeof parsedJson.url === 'string') {
      saveMcpClientSecret(name, {
        type: parsedJson.type,
        url: parsedJson.url
      }, clientSecret);
    }
    logEvent('tengu_mcp_add', {
      scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source: 'json' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      type: transportType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    cliOk(`Added ${transportType} MCP server ${name} to ${scope} config`);
  } catch (error) {
    cliError((error as Error).message);
  }
}

// mcp add-from-claude-desktop (lines 4881–4927)
export async function mcpAddFromDesktopHandler(options: {
  scope?: string;
}): Promise<void> {
  try {
    const scope = ensureConfigScope(options.scope);
    const platform = getPlatform();
    logEvent('tengu_mcp_add', {
      scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source: 'desktop' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    const {
      readClaudeDesktopMcpServers
    } = await import('../../utils/claudeDesktop.js');
    const servers = await readClaudeDesktopMcpServers();
    // 2.1.205 #9: report servers with invalid name characters and continue
    // importing the remaining (valid) servers instead of aborting on the
    // first invalid name encountered by `addMcpConfig`.
    const { valid: validServers, invalid } = partitionMcpServersByName(servers);
    if (invalid.length > 0) {
      const lines = invalid
        .map(i => `  - "${i.name}": ${i.reason}`)
        .join('\n');
      writeToStderr(
        `${invalid.length} server${invalid.length === 1 ? '' : 's'} from Claude Desktop skipped due to invalid name characters:\n${lines}\n`,
      );
    }
    if (Object.keys(servers).length === 0) {
      cliOk('No MCP servers found in Claude Desktop configuration or configuration file does not exist.');
    }
    if (Object.keys(validServers).length === 0) {
      cliOk('No importable MCP servers found in Claude Desktop configuration.');
    }
    const {
      unmount
    } = await render(<AppStateProvider>
        <KeybindingSetup>
          <MCPServerDesktopImportDialog servers={validServers} scope={scope} onDone={() => {
          unmount();
        }} />
        </KeybindingSetup>
      </AppStateProvider>, {
      exitOnCtrlC: true
    });
  } catch (error) {
    cliError((error as Error).message);
  }
}

// mcp reset-project-choices (lines 4935–4952)
export async function mcpResetChoicesHandler(): Promise<void> {
  logEvent('tengu_mcp_reset_mcpjson_choices', {});
  saveCurrentProjectConfig(current => ({
    ...current,
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    enableAllProjectMcpServers: false
  }));
  cliOk('All project-scoped (.mcp.json) server approvals and rejections have been reset.\n' + 'You will be prompted for approval next time you start Claude Code.');
}

// mcp login (2.1.218): per-server OAuth for HTTP/SSE MCP servers.
// claude.ai connector servers authenticate via the Anthropic account, not
// per-server OAuth — route those to `auth login` rather than the consent flow.
export async function mcpLoginHandler(name: string, options: {
  noBrowser?: boolean;
}): Promise<void> {
  logEvent('tengu_mcp_oauth_login', {
    name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  const server = getMcpConfigByName(name);
  if (!server) {
    // CC 2.1.285 (item 8): official v285 login/logout not-found is
    // `si(u2t(t,s,r.size>0))` (v284: `Ui(Czt(t,s,r.size>0))` — same
    // template, no sanitizer). s = configured names minus pending/rejected;
    // OCC's getAllMcpConfigs already applies that filter.
    const { servers } = await getAllMcpConfigs();
    return cliError(mcpServerNotFoundMessageWithPending(name, Object.keys(servers), hasPendingProjectMcpServers()));
  }
  // claude.ai connector authenticates via the Anthropic account, not per-server
  // OAuth. (No connector configured in-sandbox to verify the binary's exact
  // connector-login behavior — deferred with rationale.)
  if (server.type === 'claudeai-proxy') {
    cliError(`"${name}" is a claude.ai connector — it authenticates via your Anthropic account. Run \`claude auth login\` instead.`);
  }
  if (server.type !== 'http' && server.type !== 'sse') {
    cliError(`"${name}" doesn't support OAuth login — it's only available for HTTP and SSE servers.`);
  }
  const noBrowser = options.noBrowser === true;
  const onAuthorizationUrl = (url: string) => {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(noBrowser ? `Open this URL in a browser to authorize:\n${url}` : `Opening browser to authorize MCP server "${name}"…\n${url}`);
  };
  // --no-browser: print the auth URL, then prompt the user to paste the
  // redirect URL back (SSH/headless). The browser flow otherwise resolves
  // the callback via the local loopback listener.
  //
  // 274 submitter semantics (review P2-2): a wrong-state paste returns
  // false and the flow KEEPS WAITING — so a rejected paste must re-prompt.
  // The pre-fix single-shot question discarded the boolean and closed the
  // readline, silently hanging until the 5-minute flow timeout (a
  // regression vs pre-274, where a wrong-state paste aborted immediately).
  const onWaitingForCallback = noBrowser ? (submit: (callbackUrl: string) => boolean) => {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('\nAfter authorizing, paste the full redirect URL here and press Enter:');
    const rl = readline.createInterface({ input: process.stdin });
    promptForCallbackUrlWithRetry(
      {
        question: (prompt, onAnswer) => { rl.question(prompt, onAnswer); },
        close: () => { rl.close(); },
        notify: (message) => {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(message);
        },
      },
      submit,
    );
  } : undefined;
  try {
    await performMCPOAuthFlow(name, server, onAuthorizationUrl, undefined, {
      skipBrowserOpen: noBrowser,
      onWaitingForCallback
    });
    cliOk(`Successfully authenticated with MCP server "${name}".`);
  } catch (error) {
    // CC 2.1.268 E16 (changelog: "MCP login errors"): run the failure detail
    // through the binary's `wp` redactor so secrets resolved from `${VAR}`
    // placeholders in this server's config never reach the terminal.
    cliError(`Failed to authenticate with MCP server "${name}": ${redactMcpErrorDetail(name, server, (error as Error).message, resolveUnexpandedMcpServers)}`);
  }
}

// mcp logout (2.1.218): clear stored OAuth credentials for an MCP server.
export async function mcpLogoutHandler(name: string): Promise<void> {
  logEvent('tengu_mcp_oauth_logout', {
    name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  const server = getMcpConfigByName(name);
  if (!server) {
    // CC 2.1.285 (item 8): same `u2t` builder as the login handler (the
    // official shares one resolver `v()` between login and logout).
    const { servers } = await getAllMcpConfigs();
    return cliError(mcpServerNotFoundMessageWithPending(name, Object.keys(servers), hasPendingProjectMcpServers()));
  }
  if (server.type !== 'http' && server.type !== 'sse') {
    cliError(`"${name}" doesn't use OAuth — there are no stored credentials to clear.`);
  }
  try {
    await revokeServerTokens(name, server, {});
    clearMcpClientConfig(name, server);
    cliOk(`Cleared stored OAuth credentials for MCP server "${name}".`);
  } catch (error) {
    cliError(`Failed to clear credentials for MCP server "${name}": ${(error as Error).message}`);
  }
}
