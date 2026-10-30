/**
 * Sandbox types for the Claude Code Agent SDK
 *
 * This file is the single source of truth for sandbox configuration types.
 * Both the SDK and the settings validation import from here.
 */

import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

/**
 * Network configuration schema for sandbox.
 */
export const SandboxNetworkConfigSchema = lazySchema(() =>
  z
    .object({
      allowedDomains: z.array(z.string()).optional(),
      // 2.1.113: block specific domains even when a broader allowedDomains
      // wildcard would otherwise permit them.
      deniedDomains: z
        .array(z.string())
        .optional()
        .describe(
          'Domains to block even when a broader allowedDomains wildcard would otherwise permit them.',
        ),
      allowManagedDomainsOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (and set in managed settings), only allowedDomains and WebFetch(domain:...) allow rules from managed settings are respected. ' +
            'User, project, local, and flag settings domains are ignored. Denied domains are still respected from all sources.',
        ),
      // 2.1.219: deny non-allowlisted hosts for sandboxed commands without
      // prompting. Recovered verbatim from the 2.1.220 linux-x64 ELF settings
      // schema (offset ~247994700). Only honored from user, flag (--settings),
      // or policy (managed) sources — project settings are ignored.
      strictAllowlist: z
        .boolean()
        .optional()
        .describe(
          'When true, the sandbox runtime deterministically denies hosts not in allowedDomains instead of prompting. ' +
            'Enforced for sandboxed commands only — in-process tools such as WebFetch are not gated by this setting. ' +
            'Only honored from user, managed/policy, or CLI (--settings) settings — ' +
            'project settings (.claude/settings.json and .claude/settings.local.json) are ignored.',
        ),
      allowUnixSockets: z
        .array(z.string())
        .optional()
        .describe(
          'macOS only: Unix socket paths to allow. Ignored on Linux (seccomp cannot filter by path).',
        ),
      allowAllUnixSockets: z
        .boolean()
        .optional()
        .describe(
          'If true, allow all Unix sockets (disables blocking on both platforms).',
        ),
      allowLocalBinding: z.boolean().optional(),
      httpProxyPort: z.number().optional(),
      socksProxyPort: z.number().optional(),
    })
    .optional(),
)

/**
 * Filesystem configuration schema for sandbox.
 */
export const SandboxFilesystemConfigSchema = lazySchema(() =>
  z
    .object({
      // 2.1.216: skip filesystem isolation while keeping network egress control.
      // Stage 1 adds the schema field only; the bwrap/seccomp wiring that
      // actually skips filesystem rules is security-sensitive and lands in a
      // later, security-reviewed stage. Official behavior: when true, the
      // sandbox drops filesystem deny rules (`yl.filesystem.disabled` short-
      // circuits the deny-path computation) while keeping network isolation.
      disabled: z
        .boolean()
        .optional()
        .describe(
          'macOS and Linux/WSL only: skip filesystem isolation entirely while ' +
            'keeping network and seccomp isolation. Ignored on native Windows, ' +
            'where the sandboxed process runs as a separate user with no ' +
            'inherent rights, so skipping the filesystem rules would withhold ' +
            'every access grant rather than loosen them — filesystem isolation ' +
            'stays on there.',
        ),
      allowWrite: z
        .array(z.string())
        .optional()
        .describe(
          // CC 2.1.292 (OCC-150): trailing re-check sentence is byte-verbatim
          // from the official allowWrite-side describe (Wc @11317030 of the
          // 2.1.292 linux-x64 ELF). The official describe is assembled at
          // runtime from conditional fragments (Fc/$c gates incl. a
          // credentials.files leg OCC does not have); OCC keeps its static
          // short describe and appends the sentence its behavior now matches
          // (per-command refreshConfig() in wrapWithSandbox).
          'Additional paths to allow writing within the sandbox. ' +
            'Merged with paths from Edit(...) allow permission rules. ' +
            'A value inside a directory sandboxed commands can already write ' +
            'is re-checked before every command and dropped once it has been ' +
            're-pointed into a denied read path.',
        ),
      denyWrite: z
        .array(z.string())
        .optional()
        .describe(
          'Additional paths to deny writing within the sandbox. ' +
            'Merged with paths from Edit(...) deny permission rules.',
        ),
      denyRead: z
        .array(z.string())
        .optional()
        .describe(
          'Additional paths to deny reading within the sandbox. ' +
            'Merged with paths from Read(...) deny permission rules.',
        ),
      allowRead: z
        .array(z.string())
        .optional()
        .describe(
          // CC 2.1.292 (OCC-150): trailing re-check sentence is byte-verbatim
          // from the official allowRead-side describe (Bc @14021955 of the
          // 2.1.292 linux-x64 ELF) — same assembly note as allowWrite above.
          'Paths to re-allow reading within denyRead regions. ' +
            'Takes precedence over denyRead for matching paths. ' +
            'A value inside a directory sandboxed commands can write is ' +
            're-checked before every command and dropped once it has been ' +
            're-pointed into a denied path.',
        ),
      allowManagedReadPathsOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (set in managed settings), only allowRead paths from policySettings are used.',
        ),
    })
    .optional(),
)

/**
 * Sandbox settings schema.
 */
export const SandboxSettingsSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().optional(),
      failIfUnavailable: z
        .boolean()
        .optional()
        .describe(
          'Exit with an error at startup if sandbox.enabled is true but the sandbox cannot start ' +
            '(missing dependencies, unsupported platform, or platform not in enabledPlatforms). ' +
            'When false (default), a warning is shown and commands run unsandboxed. ' +
            'Intended for managed-settings deployments that require sandboxing as a hard gate.',
        ),
      // Note: enabledPlatforms is an undocumented setting read via .passthrough()
      // It restricts sandboxing to specific platforms (e.g., ["macos"]).
      //
      // Added to unblock NVIDIA enterprise rollout: they want to enable
      // autoAllowBashIfSandboxed but only on macOS initially, since Linux/WSL
      // sandbox support is newer and less battle-tested. This allows them to
      // set enabledPlatforms: ["macos"] to disable sandbox (and auto-allow)
      // on other platforms until they're ready to expand.
      autoAllowBashIfSandboxed: z.boolean().optional(),
      allowUnsandboxedCommands: z
        .boolean()
        .optional()
        .describe(
          'Allow commands to run outside the sandbox via the dangerouslyDisableSandbox parameter. ' +
            'When false, the dangerouslyDisableSandbox parameter is completely ignored and all commands must run sandboxed. ' +
            'Default: true.',
        ),
      network: SandboxNetworkConfigSchema(),
      filesystem: SandboxFilesystemConfigSchema(),
      ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
      enableWeakerNestedSandbox: z.boolean().optional(),
      // CC 2.1.305 (v306 binary @238321756): describe text byte-verified
      // against the official ELF, including the **Removes code-execution
      // isolation** markdown, the em-dashes, and the trusted-tier note. The
      // official's `${je}` interpolant is the literal "project settings
      // (.claude/settings.json and .claude/settings.local.json)" string
      // (@129034724 region), substituted inline here.
      allowNestedUserNamespaces: z
        .boolean()
        .optional()
        .describe(
          "Linux/WSL only: Let sandboxed commands create user namespaces of their own, which the sandbox refuses by default. Needed by tools that sandbox themselves that way, such as Chromium's and Electron's sandbox, rootless podman or buildah, a nested bubblewrap, and `unshare`. " +
            '**Removes code-execution isolation** — in any folder a hostile command may write, it can then bypass filesystem.denyWrite, filesystem.denyRead, credentials.files entries and the paths the sandbox always write-protects (such as .claude/settings.json, git hooks and git config), ' +
            'and so plant code that later runs outside the sandbox; while autoAllowBashIfSandboxed is on, the command that plants it needs no approval. Default: false. ' +
            'Only honored from user, managed/policy, or CLI (--settings) settings — ' +
            'true from project settings (.claude/settings.json and .claude/settings.local.json) is ignored (false there still applies).',
        ),
      enableWeakerNetworkIsolation: z
        .boolean()
        .optional()
        .describe(
          'macOS only: Allow access to com.apple.trustd.agent in the sandbox. ' +
            'Needed for Go-based CLI tools (gh, gcloud, terraform, etc.) to verify TLS certificates ' +
            'when using httpProxyPort with a MITM proxy and custom CA. ' +
            '**Reduces security** — opens a potential data exfiltration vector through the trustd service. Default: false',
        ),
      // 2.1.169: allow sandboxed commands to send Apple Events on macOS.
      // Needed by tools that drive other apps via AppleScript / osascript.
      allowAppleEvents: z
        .boolean()
        .optional()
        .describe(
          'macOS only: Allow sandboxed commands to send Apple Events to other ' +
            'applications via the Apple Event service. Default: false',
        ),
      excludedCommands: z
        .array(z.string())
        .optional()
        // CC 2.1.314 #30: base sentences REWORDED from the 2.1.282 text
        // (v312 @239635789 said "that always run outside the sandbox");
        // v314 base byte-verified @244324279 — documents the every-part
        // matching requirement and the still-sandboxed call shapes. The `Md`
        // restriction suffix is byte-identical v312→v314 (unchanged).
        .describe(
          'Command patterns (Bash permission-rule syntax) for commands to run outside the sandbox. An entry takes a call out of the sandbox only when every command in the call matches an entry: in a Bash pipe or a chain such as `a && b`, each part needs its own match. Some calls stay sandboxed whatever the entries, such as one with a `cd`, a command substitution, or a redirect other than a file-descriptor duplication like `2>&1`, a heredoc included. A convenience, not a security boundary: excluded commands still go through the permission flow. Merged across settings sources. ' +
            'When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, values from project settings (.claude/settings.json and .claude/settings.local.json) are ignored.',
        ),
      // 2.1.187: block sandboxed commands from reading credential files
      // and secret environment variables.
      credentials: z
        .object({
          enabled: z
            .boolean()
            .optional()
            .describe('When true, block sandboxed commands from reading credential files and secret env vars.'),
        })
        .optional(),
      ripgrep: z
        .object({
          command: z.string(),
          args: z.array(z.string()).optional(),
        })
        .optional()
        .describe('Custom ripgrep configuration for bundled ripgrep support'),
    })
    .passthrough(),
)

// Inferred types from schemas
export type SandboxSettings = z.infer<ReturnType<typeof SandboxSettingsSchema>>
export type SandboxNetworkConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxNetworkConfigSchema>>
>
export type SandboxFilesystemConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxFilesystemConfigSchema>>
>
export type SandboxIgnoreViolations = NonNullable<
  SandboxSettings['ignoreViolations']
>
