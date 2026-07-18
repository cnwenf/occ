import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../../Tool'
import {
  hasDockerDaemonRedirectFlag,
  _matchingRulesForInputForTesting,
} from '../bashPermissions'

/**
 * M7 (Claude Code 2.1.214): docker/podman daemon-redirect flags must prompt,
 * not auto-allow via a prefix rule. `--url`/`--connection`/`--identity` (docker
 * or podman) + `--remote` (podman only). Token equality or `--flag=` prefix;
 * no substring match (avoids `--url-list` false hit). Both `--flag value`
 * (space) and `--flag=value` (equals) forms.
 *
 * Red-test per security reviewer: two groups × 4 flags, pre+post position.
 */

function ctxWithAllow(allow: string[]): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: { userSettings: allow },
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

describe('M7 (2.1.214): docker daemon-redirect flag detection', () => {
  describe('hasDockerDaemonRedirectFlag (pure)', () => {
    // Group A: flag AFTER subcommand (e.g. `docker ps --url=…`)
    test('docker ps --url=tcp://evil → redirect', () => {
      expect(hasDockerDaemonRedirectFlag('docker ps --url=tcp://evil')).toBe(true)
    })
    test('docker ps --connection=foo → redirect', () => {
      expect(hasDockerDaemonRedirectFlag('docker ps --connection=foo')).toBe(true)
    })
    test('docker ps --identity=x → redirect', () => {
      expect(hasDockerDaemonRedirectFlag('docker ps --identity=x')).toBe(true)
    })
    test('podman ps --remote → redirect', () => {
      expect(hasDockerDaemonRedirectFlag('podman ps --remote')).toBe(true)
    })

    // Group B: flag BEFORE subcommand (e.g. `docker --url=… ps`)
    test('docker --url=tcp://evil ps → redirect', () => {
      expect(hasDockerDaemonRedirectFlag('docker --url=tcp://evil ps')).toBe(true)
    })
    test('docker --connection=foo ps → redirect', () => {
      expect(hasDockerDaemonRedirectFlag('docker --connection=foo ps')).toBe(true)
    })
    test('docker --identity=x ps → redirect', () => {
      expect(hasDockerDaemonRedirectFlag('docker --identity=x ps')).toBe(true)
    })
    test('podman --remote ps → redirect', () => {
      expect(hasDockerDaemonRedirectFlag('podman --remote ps')).toBe(true)
    })

    // Space form (`--flag value`)
    test('docker --url tcp://evil ps (space form) → redirect', () => {
      expect(hasDockerDaemonRedirectFlag('docker --url tcp://evil ps')).toBe(true)
    })

    // Negatives / no false-hit
    test('docker --remote ps → NOT a redirect (docker, not podman)', () => {
      expect(hasDockerDaemonRedirectFlag('docker --remote ps')).toBe(false)
    })
    test('docker ps --url-list=x → NOT a redirect (no substring match)', () => {
      expect(hasDockerDaemonRedirectFlag('docker ps --url-list=x')).toBe(false)
    })
    test('plain docker ps → NOT a redirect', () => {
      expect(hasDockerDaemonRedirectFlag('docker ps')).toBe(false)
    })
    test('echo docker --url=x → NOT a redirect (docker is an arg, not command-start)', () => {
      expect(hasDockerDaemonRedirectFlag('echo docker --url=x')).toBe(false)
    })
    test('non-docker command → NOT a redirect', () => {
      expect(hasDockerDaemonRedirectFlag('ls --url=x')).toBe(false)
    })
    test('compound: cd /x && docker ps --url=y → redirect', () => {
      expect(hasDockerDaemonRedirectFlag('cd /x && docker ps --url=y')).toBe(true)
    })
  })

  describe('matchingRulesForInput integration: allow cleared on redirect', () => {
    test('docker ps --url=tcp://evil + Bash(docker ps:*) → allow cleared (ask)', () => {
      const ctx = ctxWithAllow(['Bash(docker ps:*)'])
      const r = _matchingRulesForInputForTesting(
        { command: 'docker ps --url=tcp://evil' },
        ctx,
        'exact',
      )
      expect(r.matchingAllowRules.length).toBe(0) // cleared → falls to ask
    })
    test('docker --url=tcp://evil ps + Bash(docker:*) → allow cleared', () => {
      const ctx = ctxWithAllow(['Bash(docker:*)'])
      const r = _matchingRulesForInputForTesting(
        { command: 'docker --url=tcp://evil ps' },
        ctx,
        'exact',
      )
      expect(r.matchingAllowRules.length).toBe(0)
    })
    test('plain docker ps + Bash(docker ps:*) → allow still matches (no regression)', () => {
      const ctx = ctxWithAllow(['Bash(docker ps:*)'])
      const r = _matchingRulesForInputForTesting(
        { command: 'docker ps' },
        ctx,
        'exact',
      )
      expect(r.matchingAllowRules.length).toBeGreaterThan(0)
    })
    // `docker --remote ps` is NOT a redirect (docker --remote is podman-only);
    // hasDockerDaemonRedirectFlag returns false for it (covered in the pure
    // suite above). The Bash(docker:*) allow rule not matching a flag-bearing
    // command is a rule-matcher behavior unrelated to M7, so it is not asserted
    // here.
  })
})
