/**
 * Utilities for handling local installation
 */

import { existsSync } from 'fs'
import { access, chmod, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { type ReleaseChannel, saveGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'
import { parseVersion } from './semver.js'
import { jsonStringify } from './slowOperations.js'

// Lazy getters: getClaudeConfigHomeDir() is memoized and reads process.env.
// Evaluating at module scope would capture the value before entrypoints like
// hfi.tsx get a chance to set CLAUDE_CONFIG_DIR in main(), and would also
// populate the memoize cache with that stale value for all 150+ other callers.
function getLocalInstallDir(): string {
  return join(getClaudeConfigHomeDir(), 'local')
}
export function getLocalClaudePath(): string {
  return join(getLocalInstallDir(), 'claude')
}

/**
 * Check if we're running from our managed local installation
 */
export function isRunningFromLocalInstallation(): boolean {
  const execPath = process.argv[1] || ''
  return execPath.includes('/.claude/local/node_modules/')
}

/**
 * Write `content` to `path` only if the file does not already exist.
 * Uses O_EXCL ('wx') for atomic create-if-missing.
 */
async function writeIfMissing(
  path: string,
  content: string,
  mode?: number,
): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode })
    return true
  } catch (e) {
    if (getErrnoCode(e) === 'EEXIST') return false
    throw e
  }
}

/**
 * Ensure the local package environment is set up
 * Creates the directory, package.json, and wrapper script
 */
export async function ensureLocalPackageEnvironment(): Promise<boolean> {
  try {
    const localInstallDir = getLocalInstallDir()

    // Create installation directory (recursive, idempotent)
    await getFsImplementation().mkdir(localInstallDir)

    // Create package.json if it doesn't exist
    await writeIfMissing(
      join(localInstallDir, 'package.json'),
      jsonStringify(
        { name: 'claude-local', version: '0.0.1', private: true },
        null,
        2,
      ),
    )

    // Create the wrapper script if it doesn't exist
    const wrapperPath = join(localInstallDir, 'claude')
    const created = await writeIfMissing(
      wrapperPath,
      `#!/bin/sh\nexec "${localInstallDir}/node_modules/.bin/claude" "$@"`,
      0o755,
    )
    if (created) {
      // Mode in writeFile is masked by umask; chmod to ensure executable bit.
      await chmod(wrapperPath, 0o755)
    }

    return true
  } catch (error) {
    logError(error)
    return false
  }
}

/**
 * CC 2.1.288 #50 — post-install verification protocol.
 *
 * Official v288 (@~211722400, recovered in docs/gap-research-288/
 * cluster-b-protocol-auth-mcp-plugin.md "Item 50") stopped trusting the
 * package manager's exit code alone: after `install` exits 0 it re-probes the
 * installed binary's `--version` and only reports success when the probe
 * confirms a real version landed. When the installed file is still the
 * placeholder stub, it checks whether npm install scripts are deliberately
 * disabled (`npm config get ignore-scripts` === "true") — if so it trusts the
 * exit code; otherwise it fails with `install_failed` +
 * `native_binary_missing`. An inconclusive probe (crash / unparseable output)
 * trusts the exit code with a log.
 *
 * OCC adaptation: OCC ships no platform-native binary (build sets
 * NATIVE_PACKAGE_URL=''), so the official "platform-native package was not
 * installed" wording becomes "platform package binary was not installed"; the
 * "still the placeholder stub" wording is kept verbatim. Official telemetry
 * names `update_apply` / `update_apply_native_binary_missing` are kept
 * verbatim as OCC event names (the recovered official call
 * `m("update_apply","update_apply_native_binary_missing")` cannot be fully
 * disambiguated, and OCC's logEvent metadata cannot carry string values).
 */

const PROBE_TIMEOUT_MS = 10_000
const IGNORE_SCRIPTS_TIMEOUT_MS = 10_000

type PostInstallProbeOutcome = 'landed' | 'placeholder_stub' | 'inconclusive'

export type PostInstallVerificationResult =
  | { status: 'success'; probeDurationMs: number }
  | { status: 'install_failed'; failureHint: 'native_binary_missing' }

/** Binary names to look for when resolving the installed probe target. */
function getProbeBinaryNames(): string[] {
  const names = [MACRO.BINARY_NAME, 'claude']
  return names.filter((name): name is string => Boolean(name))
}

/**
 * Extract a semver from `--version` output. Handles both bare versions
 * ("2.1.367") and branded output ("OCC 2.1.367").
 */
function extractSemverFromOutput(stdout: string): string | null {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }
  const direct = parseVersion(trimmed)
  if (direct) {
    return direct
  }
  for (const token of trimmed.split(/\s+/)) {
    const parsed = parseVersion(token)
    if (parsed) {
      return parsed
    }
  }
  return null
}

/**
 * Resolve the real installed binary under the local install dir. Returns null
 * when only the `writeIfMissing` placeholder stub wrapper exists with no real
 * package binary behind it (the OCC analog of the official stub state).
 */
function resolveLocalProbeTarget(): string | null {
  const binDir = join(getLocalInstallDir(), 'node_modules', '.bin')
  for (const name of getProbeBinaryNames()) {
    const candidate = join(binDir, name)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * Resolve the real installed binary under a global install prefix.
 * npm prefixes hold binaries in `<prefix>/bin`; bun's `bun pm bin -g` returns
 * the bin directory itself — check both layouts. Returns null when no binary
 * landed at all (placeholder-stub state).
 */
export function resolveGlobalProbeTarget(prefix: string | null): string | null {
  if (!prefix) {
    return null
  }
  for (const dir of [join(prefix, 'bin'), prefix]) {
    for (const name of getProbeBinaryNames()) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }
  return null
}

/** Run `<target> --version` and classify the outcome. Never throws. */
async function probeInstalledBinary(targetPath: string): Promise<{
  outcome: PostInstallProbeOutcome
  durationMs: number
  version: string | null
}> {
  const startedAt = Date.now()
  try {
    const result = await execFileNoThrowWithCwd(targetPath, ['--version'], {
      cwd: homedir(),
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const durationMs = Date.now() - startedAt
    if (result.code === 0) {
      const version = extractSemverFromOutput(result.stdout)
      if (version) {
        return { outcome: 'landed', durationMs, version }
      }
    }
    return { outcome: 'inconclusive', durationMs, version: null }
  } catch {
    return {
      outcome: 'inconclusive',
      durationMs: Date.now() - startedAt,
      version: null,
    }
  }
}

/** Official v288 `Je("npm",["config","get","ignore-scripts"],{timeout:1e4})`. */
async function queryNpmIgnoreScripts(): Promise<{
  code: number
  stdout: string
} | null> {
  try {
    // Run from home directory to avoid reading project-level .npmrc
    return await execFileNoThrowWithCwd(
      'npm',
      ['config', 'get', 'ignore-scripts'],
      {
        cwd: homedir(),
        abortSignal: AbortSignal.timeout(IGNORE_SCRIPTS_TIMEOUT_MS),
      },
    )
  } catch {
    return null
  }
}

/**
 * Verify that a package-manager install which already exited 0 actually
 * landed a working binary. Mirrors the recovered official v288 switch on
 * placeholder_stub / inconclusive / landed, including the deliberate
 * npm-ignore-scripts exemption (official: only when the package manager is
 * npm and `npm config get ignore-scripts` exits 0 printing exactly "true").
 */
export async function verifyNpmInstallLanded(
  packageManager: 'npm' | 'bun',
  resolveProbeTarget: () => string | null,
): Promise<PostInstallVerificationResult> {
  const startedAt = Date.now()
  const target = resolveProbeTarget()
  const probe = target === null ? null : await probeInstalledBinary(target)
  const outcome: PostInstallProbeOutcome =
    probe === null ? 'placeholder_stub' : probe.outcome
  const probeDurationMs = probe === null ? Date.now() - startedAt : probe.durationMs

  switch (outcome) {
    case 'placeholder_stub': {
      const ignoreScripts =
        packageManager === 'npm' ? await queryNpmIgnoreScripts() : null
      if (
        ignoreScripts !== null &&
        ignoreScripts.code === 0 &&
        ignoreScripts.stdout.trim() === 'true'
      ) {
        logForDebugging(
          `${packageManager} exited 0 and the installed claude is the placeholder stub, but npm install scripts are disabled on purpose; trusting the exit code`,
        )
        logEvent('update_apply', { probeDurationMs })
        return { status: 'success', probeDurationMs }
      }
      logEvent('update_apply_native_binary_missing', { probeDurationMs })
      logForDebugging(
        `${packageManager} exited 0 but the installed claude is still the placeholder stub: the platform package binary was not installed`,
        { level: 'error' },
      )
      return { status: 'install_failed', failureHint: 'native_binary_missing' }
    }
    case 'inconclusive': {
      logForDebugging(
        `${packageManager} exited 0; the install-prefix --version probe was inconclusive, trusting the exit code`,
      )
      logEvent('update_apply', { probeDurationMs })
      return { status: 'success', probeDurationMs }
    }
    case 'landed': {
      logEvent('update_apply', { probeDurationMs })
      return { status: 'success', probeDurationMs }
    }
  }
}

/**
 * Install or update Claude CLI package in the local directory
 * @param channel - Release channel to use (latest or stable)
 * @param specificVersion - Optional specific version to install (overrides channel)
 */
export async function installOrUpdateClaudePackage(
  channel: ReleaseChannel,
  specificVersion?: string | null,
): Promise<'in_progress' | 'success' | 'install_failed'> {
  try {
    // First ensure the environment is set up
    if (!(await ensureLocalPackageEnvironment())) {
      return 'install_failed'
    }

    // Use specific version if provided, otherwise use channel tag
    const versionSpec = specificVersion
      ? specificVersion
      : channel === 'stable'
        ? 'stable'
        : 'latest'
    const result = await execFileNoThrowWithCwd(
      'npm',
      ['install', `${MACRO.PACKAGE_URL}@${versionSpec}`],
      { cwd: getLocalInstallDir(), maxBuffer: 1000000 },
    )

    if (result.code !== 0) {
      const error = new Error(
        `Failed to install Claude CLI package: ${result.stderr}`,
      )
      logError(error)
      return result.code === 190 ? 'in_progress' : 'install_failed'
    }

    // 2.1.288 #50: exit 0 alone no longer means success — re-probe the
    // installed binary's --version before reporting the update as applied.
    const verification = await verifyNpmInstallLanded(
      'npm',
      resolveLocalProbeTarget,
    )
    if (verification.status === 'install_failed') {
      return 'install_failed'
    }

    // Set installMethod to 'local' to prevent npm permission warnings
    saveGlobalConfig(current => ({
      ...current,
      installMethod: 'local',
    }))

    return 'success'
  } catch (error) {
    logError(error)
    return 'install_failed'
  }
}

/**
 * Check if local installation exists.
 * Pure existence probe — callers use this to choose update path / UI hints.
 */
export async function localInstallationExists(): Promise<boolean> {
  try {
    await access(join(getLocalInstallDir(), 'node_modules', '.bin', 'claude'))
    return true
  } catch {
    return false
  }
}

/**
 * Get shell type to determine appropriate path setup
 */
export function getShellType(): string {
  const shellPath = process.env.SHELL || ''
  if (shellPath.includes('zsh')) return 'zsh'
  if (shellPath.includes('bash')) return 'bash'
  if (shellPath.includes('fish')) return 'fish'
  return 'unknown'
}
