import { getPluginErrorMessage, type PluginError } from '../../types/plugin.js';
import { redactCredentialsInText, redactUrlCredentials } from '../../utils/redactUrl.js';
// Security (2.1.275 upstream port): URL-typed fields are scrubbed with
// redactUrlCredentials and every assembled message is swept with
// redactCredentialsInText so credentials in plugin/marketplace URLs can never
// reach the UI through an error message.
export function formatErrorMessage(error: PluginError): string {
  return redactCredentialsInText(buildErrorMessage(error));
}
function buildErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'path-not-found':
      return `${error.component} path not found: ${error.path}`;
    case 'path-traversal':
      return `${error.component} path escapes plugin directory: ${error.path}`;
    case 'git-auth-failed':
      return `Git ${error.authType.toUpperCase()} authentication failed for ${redactUrlCredentials(error.gitUrl)}`;
    case 'git-timeout':
      return `Git ${error.operation} timed out for ${redactUrlCredentials(error.gitUrl)}`;
    case 'network-error':
      return `Network error accessing ${redactUrlCredentials(error.url)}${error.details ? `: ${error.details}` : ''}`;
    case 'manifest-parse-error':
      return `Failed to parse manifest at ${error.manifestPath}: ${error.parseError}`;
    case 'manifest-validation-error':
      return `Invalid manifest at ${error.manifestPath}: ${error.validationErrors.join(', ')}`;
    case 'plugin-not-found':
      return `Plugin "${error.pluginId}" not found in marketplace "${error.marketplace}"`;
    case 'marketplace-not-found':
      return `Marketplace "${error.marketplace}" not found`;
    case 'marketplace-load-failed':
      return `Failed to load marketplace "${error.marketplace}": ${error.reason}`;
    case 'mcp-config-invalid':
      return `Invalid MCP server config for "${error.serverName}": ${error.validationError}`;
    case 'mcp-server-suppressed-duplicate':
      {
        const dup = error.duplicateOf.startsWith('plugin:') ? `server provided by plugin "${error.duplicateOf.split(':')[1] ?? '?'}"` : `already-configured "${error.duplicateOf}"`;
        return `MCP server "${error.serverName}" skipped — same command/URL as ${dup}`;
      }
    case 'hook-load-failed':
      return `Failed to load hooks from ${error.hookPath}: ${error.reason}`;
    case 'component-load-failed':
      return `Failed to load ${error.component} from ${error.path}: ${error.reason}`;
    case 'mcpb-download-failed':
      return `Failed to download MCPB from ${redactUrlCredentials(error.url)}: ${error.reason}`;
    case 'mcpb-extract-failed':
      return `Failed to extract MCPB ${error.mcpbPath}: ${error.reason}`;
    case 'mcpb-invalid-manifest':
      return `MCPB manifest invalid at ${error.mcpbPath}: ${error.validationError}`;
    case 'marketplace-blocked-by-policy':
      return error.blockedByBlocklist ? `Marketplace "${error.marketplace}" is blocked by enterprise policy` : `Marketplace "${error.marketplace}" is not in the allowed marketplace list`;
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled' ? `Dependency "${error.dependency}" is disabled` : `Dependency "${error.dependency}" is not installed`;
    case 'lsp-config-invalid':
      return `Invalid LSP server config for "${error.serverName}": ${error.validationError}`;
    case 'lsp-server-start-failed':
      return `LSP server "${error.serverName}" failed to start: ${error.reason}`;
    case 'lsp-server-crashed':
      return error.signal ? `LSP server "${error.serverName}" crashed with signal ${error.signal}` : `LSP server "${error.serverName}" crashed with exit code ${error.exitCode ?? 'unknown'}`;
    case 'lsp-request-timeout':
      return `LSP server "${error.serverName}" timed out on ${error.method} after ${error.timeoutMs}ms`;
    case 'lsp-request-failed':
      return `LSP server "${error.serverName}" ${error.method} failed: ${error.error}`;
    case 'plugin-cache-miss':
      return `Plugin "${error.plugin}" not cached at ${error.installPath}`;
    case 'generic-error':
      return error.error;
  }
  const _exhaustive: never = error;
  return getPluginErrorMessage(_exhaustive);
}
// Security (2.1.275 upstream port): guidance strings embed marketplace names
// and formatted source strings (which may be git/url sources carrying
// credentials) — sweep the assembled guidance so userinfo never renders.
export function getErrorGuidance(error: PluginError): string | null {
  const guidance = buildErrorGuidance(error);
  return guidance === null ? null : redactCredentialsInText(guidance);
}
function buildErrorGuidance(error: PluginError): string | null {
  switch (error.type) {
    case 'path-not-found':
      return 'Check that the path in your manifest or marketplace config is correct';
    case 'path-traversal':
      return 'Paths in plugin.json must not use ".." to reference files outside the plugin directory';
    case 'git-auth-failed':
      return error.authType === 'ssh' ? 'Configure SSH keys or use HTTPS URL instead' : 'Configure credentials or use SSH URL instead';
    case 'git-timeout':
    case 'network-error':
      return 'Check your internet connection and try again';
    case 'manifest-parse-error':
      return 'Check manifest file syntax in the plugin directory';
    case 'manifest-validation-error':
      return 'Check manifest file follows the required schema';
    case 'plugin-not-found':
      return `Plugin may not exist in marketplace "${error.marketplace}"`;
    case 'marketplace-not-found':
      return error.availableMarketplaces.length > 0 ? `Available marketplaces: ${error.availableMarketplaces.join(', ')}` : 'Add the marketplace first using /plugin marketplace add';
    case 'mcp-config-invalid':
      return 'Check MCP server configuration in .mcp.json or manifest';
    case 'mcp-server-suppressed-duplicate':
      {
        // duplicateOf is "plugin:name:srv" when another plugin won dedup —
        // users can't remove plugin-provided servers from their MCP config,
        // so point them at the winning plugin instead.
        if (error.duplicateOf.startsWith('plugin:')) {
          const winningPlugin = error.duplicateOf.split(':')[1] ?? 'the other plugin';
          return `Disable plugin "${winningPlugin}" if you want this plugin's version instead`;
        }
        return `Remove "${error.duplicateOf}" from your MCP config if you want the plugin's version instead`;
      }
    case 'hook-load-failed':
      return 'Check hooks.json file syntax and structure';
    case 'component-load-failed':
      return `Check ${error.component} directory structure and file permissions`;
    case 'mcpb-download-failed':
      return 'Check your internet connection and URL accessibility';
    case 'mcpb-extract-failed':
      return 'Verify the MCPB file is valid and not corrupted';
    case 'mcpb-invalid-manifest':
      return 'Contact the plugin author about the invalid manifest';
    case 'marketplace-blocked-by-policy':
      if (error.blockedByBlocklist) {
        return 'This marketplace source is explicitly blocked by your administrator';
      }
      return error.allowedSources.length > 0 ? `Allowed sources: ${error.allowedSources.join(', ')}` : 'Contact your administrator to configure allowed marketplace sources';
    case 'dependency-unsatisfied':
      return error.reason === 'not-enabled' ? `Enable "${error.dependency}" or uninstall "${error.plugin}"` : `Install "${error.dependency}" or uninstall "${error.plugin}"`;
    case 'lsp-config-invalid':
      return 'Check LSP server configuration in the plugin manifest';
    case 'lsp-server-start-failed':
    case 'lsp-server-crashed':
    case 'lsp-request-timeout':
    case 'lsp-request-failed':
      return 'Check LSP server logs with --debug for details';
    case 'plugin-cache-miss':
      return 'Run /plugins to refresh the plugin cache';
    case 'marketplace-load-failed':
    case 'generic-error':
      return null;
  }
  const _exhaustive: never = error;
  return null;
}
