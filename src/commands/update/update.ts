import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import type { LocalCommandCall } from '../../types/command.js'

const INSTALL_TIMEOUT_MS = 180_000

/** The npm package name for OCC, injected at build time via MACRO.PACKAGE_URL. */
function packageName(): string {
  return (globalThis as { MACRO?: { PACKAGE_URL?: string } }).MACRO?.PACKAGE_URL ?? ''
}

/** Current OCC version from the build-time MACRO.VERSION global. */
function currentVersion(): string {
  return (globalThis as { MACRO?: { VERSION?: string } }).MACRO?.VERSION ?? 'unknown'
}

/**
 * Detect the package manager: bun if a bun lockfile is present, else npm.
 */
function detectPackageManager(): 'bun' | 'npm' {
  if (existsSync('bun.lockb') || existsSync('bun.lock')) return 'bun'
  return 'npm'
}

/** Latest published version of the package, or null if it can't be resolved. */
function latestVersion(): string | null {
  const pkg = packageName()
  if (!pkg) return null
  try {
    const res = spawnSync(
      'npm',
      ['view', pkg, 'version'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 },
    )
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim() || null
    }
  } catch {
    /* ignore — network/npm may be unavailable */
  }
  return null
}

function runUpdate(pm: 'bun' | 'npm'): string {
  const pkg = packageName()
  if (!pkg) {
    return 'OCC package URL not configured; cannot update.'
  }
  const args = ['install', '-g', `${pkg}@latest`]
  try {
    const res = spawnSync(pm, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: INSTALL_TIMEOUT_MS,
    })
    const out = (res.stdout ?? '').trim()
    const err = (res.stderr ?? '').trim()
    if (res.status === 0) {
      return out || 'done.'
    }
    return `exit ${res.status}\n${out}\n${err}`.trim()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `failed: ${msg}`
  }
}

/**
 * /update — update OCC to the latest version.
 *
 * Shows current vs latest version, then installs globally:
 *   bun → `bun install -g @cnwenf/occ@latest`
 *   npm → `npm install -g @cnwenf/occ@latest`
 *
 * The package name is read from MACRO.PACKAGE_URL; if it is unset (e.g. the
 * polyfill was bypassed), the command reports that the URL is not configured
 * and does not spawn an install.
 */
export const call: LocalCommandCall = async () => {
  const cur = currentVersion()
  const pm = detectPackageManager()
  const latest = latestVersion()
  const lines: string[] = ['OCC update', `  current: ${cur}`, `  latest:  ${latest ?? 'unknown'}`]

  if (latest && cur !== 'unknown' && cur === latest) {
    lines.push('Already up to date.')
    return { type: 'text', value: lines.join('\n') }
  }

  lines.push(`Updating via ${pm}...`)
  lines.push(runUpdate(pm))
  return { type: 'text', value: lines.join('\n') }
}
