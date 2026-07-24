/**
 * Persistent-service install hooks for the B daemon supervisor.
 *
 * macOS  → launchd plist at ~/Library/LaunchAgents/com.anthropic.claude.daemon.plist
 * linux  → systemd user unit at ~/.config/systemd/user/claude-daemon.service
 *          + `enable-linger $USER` so the service survives logout
 * other  → "claude daemon ${a} isn't available on ${platform} (no launchd/systemd)"
 *
 * All file writes are real fs ops. The launchd/systemd CLIs (launchctl /
 * systemctl) are invoked via spawn; on platforms without them the install
 * is a no-op with a user-facing message.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { logEvent } from '../services/analytics/index.js'

export type InstallPlatform = 'launchd' | 'systemd' | 'unsupported'

/** Which persistent-service backend is available on this host. */
export function detectInstallPlatform(): InstallPlatform {
  if (process.platform === 'darwin') {
    return existsSync('/bin/launchctl') ? 'launchd' : 'unsupported'
  }
  if (process.platform === 'linux') {
    return existsSync('/bin/systemctl') || existsSync('/usr/bin/systemctl')
      ? 'systemd'
      : 'unsupported'
  }
  return 'unsupported'
}

/** The cli entry the supervisor was launched with (process.argv[1]). */
function cliEntry(): string {
  return process.argv[1] ?? 'dist/cli.js'
}

/** launchd plist path. */
export function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', 'com.anthropic.claude.daemon.plist')
}

/** systemd user unit path. */
export function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'claude-daemon.service')
}

/**
 * Install the persistent service. Returns a human-readable result string.
 * Idempotent: overwrites an existing unit/plist.
 */
export function installPersistentService(): string {
  const plat = detectInstallPlatform()
  if (plat === 'unsupported') {
    const msg = `occ daemon install isn't available on ${process.platform} (no launchd/systemd)`
    logEvent('daemon_install_unsupported', { platform: process.platform as any })
    return msg
  }

  if (plat === 'launchd') {
    return installLaunchd()
  }
  return installSystemd()
}

function installLaunchd(): string {
  const plistPath = launchdPlistPath()
  mkdirSync(join(plistPath, '..'), { recursive: true })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.anthropic.claude.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliEntry()}</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), '.claude', 'daemon.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), '.claude', 'daemon.log')}</string>
</dict>
</plist>
`
  writeFileSync(plistPath, plist, { encoding: 'utf-8' })
  spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' })
  const res = spawnSync('launchctl', ['load', plistPath], { encoding: 'utf-8' })
  logEvent('daemon_install_launchd', { ok: res.status === 0 as any })
  return res.status === 0
    ? `launchd unit installed at ${plistPath}`
    : `launchd install failed: ${res.stderr?.trim() ?? 'unknown error'}`
}

function installSystemd(): string {
  const unitPath = systemdUnitPath()
  mkdirSync(join(unitPath, '..'), { recursive: true })
  const unit = `[Unit]
Description=Claude Code background-agent daemon
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${cliEntry()} daemon start
Restart=on-failure
RestartSec=2
StandardOutput=append:${join(homedir(), '.claude', 'daemon.log')}
StandardError=append:${join(homedir(), '.claude', 'daemon.log')}

[Install]
WantedBy=default.target
`
  writeFileSync(unitPath, unit, { encoding: 'utf-8' })
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
  spawnSync('systemctl', ['--user', 'enable', 'claude-daemon.service'], { stdio: 'ignore' })
  // enable-linger so the user service survives logout (SSH cold-start hint).
  spawnSync('loginctl', ['enable-linger', process.env.USER ?? 'root'], {
    stdio: 'ignore',
  })
  logEvent('daemon_install_systemd', {})
  return `systemd unit installed at ${unitPath} (enable-linger ${process.env.USER ?? 'root'})`
}

/**
 * Uninstall the persistent service. Idempotent.
 */
export function uninstallPersistentService(): string {
  const plat = detectInstallPlatform()
  if (plat === 'launchd') {
    const plistPath = launchdPlistPath()
    spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' })
    try {
      unlinkSync(plistPath)
    } catch {
      /* ignore */
    }
    logEvent('daemon_uninstall_launchd', {})
    return `launchd unit removed`
  }
  if (plat === 'systemd') {
    spawnSync('systemctl', ['--user', 'disable', 'claude-daemon.service'], {
      stdio: 'ignore',
    })
    try {
      unlinkSync(systemdUnitPath())
    } catch {
      /* ignore */
    }
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
    logEvent('daemon_uninstall_systemd', {})
    return `systemd unit removed`
  }
  return `occ daemon uninstall isn't available on ${process.platform} (no launchd/systemd)`
}
