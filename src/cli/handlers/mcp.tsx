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
import { connectToServer, getMcpServerConnectionBatchSize } from '../../services/mcp/client.js';
import { addMcpConfig, getAllMcpConfigs, getMcpConfigByName, getMcpConfigsByScope, removeMcpConfig } from '../../services/mcp/config.js';
import type { ConfigScope, ScopedMcpServerConfig } from '../../services/mcp/types.js';
import { describeMcpConfigFilePath, ensureConfigScope, getScopeLabel, mcpServerHealthStatusLabel, getMcpServerFailureMessage } from '../../services/mcp/utils.js';
import { partitionMcpServersByName } from '../../services/mcp/normalization.js';
import { AppStateProvider } from '../../state/AppState.js';
import { getCurrentProjectConfig, getGlobalConfig, saveCurrentProjectConfig } from '../../utils/config.js';
import { isFsInaccessible } from '../../utils/errors.js';
import { gracefulShutdown } from '../../utils/gracefulShutdown.js';
import { safeParseJSON } from '../../utils/json.js';
import { getPlatform } from '../../utils/platform.js';
import { writeToStderr } from '../../utils/process.js';
import { cliError, cliOk } from '../exit.js';
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
  const cleanupSecureStorage = () => {
    if (serverBeforeRemoval && (serverBeforeRemoval.type === 'sse' || serverBeforeRemoval.type === 'http')) {
      clearServerTokensFromLocalStorage(name, serverBeforeRemoval);
      clearMcpClientConfig(name, serverBeforeRemoval);
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
      cleanupSecureStorage();
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
      cliError(`No MCP server found with name: "${name}"`);
    } else if (scopes.length === 1) {
      // Server exists in only one scope, remove it
      const scope = scopes[0]!;
      logEvent('tengu_mcp_delete', {
        name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      await removeMcpConfig(name, scope);
      cleanupSecureStorage();
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
    for (const {
      name,
      server,
      status
    } of results) {
      // Intentionally excluding sse-ide servers here since they're internal
      if (server.type === 'sse') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} (SSE) - ${status}`);
      } else if (server.type === 'http') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} (HTTP) - ${status}`);
      } else if (server.type === 'claudeai-proxy') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${server.url} - ${status}`);
      } else if (!server.type || server.type === 'stdio') {
        const args = Array.isArray((server as any).args) ? (server as any).args : [];
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`${name}: ${(server as any).command} ${args.join(' ')} - ${status}`);
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
    cliError(`No MCP server found with name: ${name}`);
  }

  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`${name}:`);
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`  Scope: ${getScopeLabel(server.scope)}`);

  // Check server health
  const status = await checkMcpServerHealth(name, server);
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`  Status: ${status}`);

  // Intentionally excluding sse-ide servers here since they're internal
  if (server.type === 'sse') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: sse`);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  URL: ${server.url}`);
    if (server.headers) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Headers:');
      for (const [key, value] of Object.entries(server.headers)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}: ${value}`);
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
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  OAuth: ${parts.join(', ')}`);
    }
  } else if (server.type === 'http') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: http`);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  URL: ${server.url}`);
    if (server.headers) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Headers:');
      for (const [key, value] of Object.entries(server.headers)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}: ${value}`);
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
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  OAuth: ${parts.join(', ')}`);
    }
  } else if (server.type === 'stdio') {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Type: stdio`);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Command: ${server.command}`);
    const args = Array.isArray(server.args) ? server.args : [];
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`  Args: ${args.join(' ')}`);
    if (server.env) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('  Environment:');
      for (const [key, value] of Object.entries(server.env)) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    ${key}=${value}`);
      }
    }
  }
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.log(`\nTo remove this server, run: occ mcp remove "${name}" -s ${server.scope}`);
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
    const { servers } = await getAllMcpConfigs();
    cliError(`No MCP server named "${name}". Configured servers: ${Object.keys(servers).join(', ')}`);
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
  const onWaitingForCallback = noBrowser ? (submit: (callbackUrl: string) => void) => {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('\nAfter authorizing, paste the full redirect URL here and press Enter:');
    const rl = readline.createInterface({ input: process.stdin });
    rl.question('> ', (answer: string) => {
      rl.close();
      submit(answer.trim());
    });
  } : undefined;
  try {
    await performMCPOAuthFlow(name, server, onAuthorizationUrl, undefined, {
      skipBrowserOpen: noBrowser,
      onWaitingForCallback
    });
    cliOk(`Successfully authenticated with MCP server "${name}".`);
  } catch (error) {
    cliError(`Failed to authenticate with MCP server "${name}": ${(error as Error).message}`);
  }
}

// mcp logout (2.1.218): clear stored OAuth credentials for an MCP server.
export async function mcpLogoutHandler(name: string): Promise<void> {
  logEvent('tengu_mcp_oauth_logout', {
    name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  const server = getMcpConfigByName(name);
  if (!server) {
    const { servers } = await getAllMcpConfigs();
    cliError(`No MCP server named "${name}". Configured servers: ${Object.keys(servers).join(', ')}`);
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
