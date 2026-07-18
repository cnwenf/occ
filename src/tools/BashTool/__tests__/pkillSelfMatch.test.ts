import { describe, expect, test } from 'bun:test'
import { pkillSelfMatchDeny } from '../bashPermissions'

/**
 * M8 (Claude Code 2.1.214): `pkill -f <pattern>` that matches the CLI's own
 * process must be denied (not executed) to prevent the Bash tool from killing
 * the session. Pure-function TDD for pkillSelfMatchDeny(command, selfCmdline).
 *
 * selfCmdline = /proc/self/cmdline (ground truth); here mocked for determinism.
 * pkill -f uses ERE against the full cmdline; guard approximates with
 * new RegExp(pattern).test(selfCmdline). Invalid ERE → degrade (null), let
 * pkill self-protect.
 */

const SELF = '/root/.bun/bin/bun /root/occ/src/entrypoints/cli.tsx -p'

describe('M8 (2.1.214): pkillSelfMatchDeny (pure)', () => {
  test('pkill -f <pattern matching self> → deny', () => {
    expect(pkillSelfMatchDeny('pkill -f cli.tsx', SELF)).not.toBeNull()
  })
  test('pkill -f <unrelated pattern> → null (allow)', () => {
    expect(pkillSelfMatchDeny('pkill -f firefox', SELF)).toBeNull()
  })
  test('pkill -9f <self> (combined short flag) → deny', () => {
    expect(pkillSelfMatchDeny('pkill -9f cli.tsx', SELF)).not.toBeNull()
  })
  test('pkill -f9 <self> (combined, f first) → deny', () => {
    expect(pkillSelfMatchDeny('pkill -f9 cli.tsx', SELF)).not.toBeNull()
  })
  test('pkill <name> (no -f) → null (out of scope)', () => {
    expect(pkillSelfMatchDeny('pkill cli.tsx', SELF)).toBeNull()
  })
  test('pkill -f (no pattern) → null', () => {
    expect(pkillSelfMatchDeny('pkill -f', SELF)).toBeNull()
  })
  test('pkill -f <invalid ERE> → null (degrade, let pkill self-protect)', () => {
    expect(pkillSelfMatchDeny('pkill -f (unclosed[', SELF)).toBeNull()
  })
  test('pgrep -f <self> → null (pgrep not pkill, out of scope)', () => {
    expect(pkillSelfMatchDeny('pgrep -f cli.tsx', SELF)).toBeNull()
  })
  test('echo pkill -f cli.tsx → null (pkill not at command-start)', () => {
    expect(pkillSelfMatchDeny('echo pkill -f cli.tsx', SELF)).toBeNull()
  })
  test('pkill -f cli.tsx (selfCmdline without cli.tsx) → null', () => {
    expect(pkillSelfMatchDeny('pkill -f cli.tsx', '/usr/bin/firefox')).toBeNull()
  })
  test('compound: cd /x && pkill -f cli.tsx → deny (pkill at command-start after &&)', () => {
    expect(pkillSelfMatchDeny('cd /x && pkill -f cli.tsx', SELF)).not.toBeNull()
  })
})
