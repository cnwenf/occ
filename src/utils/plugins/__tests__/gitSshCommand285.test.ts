import { describe, expect, test } from 'bun:test'
import { __test as T, resolvePluginGitSshEnv } from '../gitSshCommand.js'

/**
 * 2.1.285 upstream port (changelog item 2): "honor GIT_SSH / core.sshCommand
 * for plugin/marketplace installs". Every assertion below is byte-derived from
 * the official v285 SSH-resolution core (linux ELF @196469100-196472703):
 *   k→nonBlank, XA→readEnv, S→deletionMap, Vr→shellQuote, ht→firstWord,
 *   Te→commandBasename, Tt→firstWordBasename, Ot→hasBatchFlag, St→resolveVariant,
 *   mt→batchOptionsFor, eKr→inferVariant, D→resolveChosenAndNamed, me→withSshCommand,
 *   X_n→resolveSshCommand, Tzo→probeCandidate, eWt→cdWrapper.
 * We assert ONLY official behavior — no invented caps or fallbacks. The tests
 * run on POSIX (getPlatform()!=='windows'), matching the CI target.
 */

const STRICT = '-o BatchMode=yes -o StrictHostKeyChecking=yes'
const BATCH_ONLY = '-o BatchMode=yes'

describe('nonBlank (official k)', () => {
  test('blank / undefined collapse to undefined; non-blank passes through', () => {
    expect(T.nonBlank(undefined)).toBeUndefined()
    expect(T.nonBlank('')).toBeUndefined()
    expect(T.nonBlank('   ')).toBeUndefined()
    expect(T.nonBlank('ssh')).toBe('ssh')
  })
})

describe('shellQuote (official Vr)', () => {
  test('empty string becomes two single quotes', () => {
    expect(T.shellQuote([''])).toBe("''")
  })
  test('safe characters pass through unquoted', () => {
    expect(T.shellQuote(['ssh'])).toBe('ssh')
    expect(T.shellQuote(['/usr/bin/ssh'])).toBe('/usr/bin/ssh')
    expect(T.shellQuote(['a=b', 'c-d'])).toBe('a=b c-d')
  })
  test('unsafe characters are single-quoted with \' escaped as \'"\'"\'', () => {
    expect(T.shellQuote(["a'b"])).toBe(`'a'"'"'b'`)
    expect(T.shellQuote(['a b'])).toBe("'a b'")
  })
})

describe('firstWord (official ht)', () => {
  test('bare, double-quoted, and single-quoted first words', () => {
    expect(T.firstWord('ssh -o X')).toBe('ssh')
    expect(T.firstWord('"my ssh" -o X')).toBe('my ssh')
    expect(T.firstWord("'my ssh' -o X")).toBe('my ssh')
    expect(T.firstWord('  /usr/bin/ssh  ')).toBe('/usr/bin/ssh')
    expect(T.firstWord('')).toBe('')
  })
})

describe('commandBasename (official Te)', () => {
  test('basename, lowercased, .exe stripped, backslashes normalized', () => {
    expect(T.commandBasename('/usr/bin/SSH')).toBe('ssh')
    expect(T.commandBasename('C:\\Program Files\\Git\\usr\\bin\\ssh.exe')).toBe(
      'ssh',
    )
    expect(T.commandBasename('  plink.EXE  ')).toBe('plink')
  })
})

describe('firstWordBasename (official Tt)', () => {
  test('quote/escape-aware first word, then basename', () => {
    expect(T.firstWordBasename('/usr/bin/ssh -o X')).toBe('ssh')
    expect(T.firstWordBasename('"my dir/plink" -batch')).toBe('plink')
    expect(T.firstWordBasename('ssh')).toBe('ssh')
  })
  test('unclosed quote returns empty', () => {
    expect(T.firstWordBasename('"unclosed ssh')).toBe('')
  })
  test('trailing backslash returns empty', () => {
    expect(T.firstWordBasename('ssh\\')).toBe('')
  })
})

describe('hasBatchFlag (official Ot)', () => {
  test('true when -batch appears after the first word', () => {
    expect(T.hasBatchFlag('plink -batch -i key')).toBe(true)
    expect(T.hasBatchFlag('"my plink" -batch')).toBe(true)
  })
  test('false when -batch is absent or glued into another token', () => {
    expect(T.hasBatchFlag('plink -i key')).toBe(false)
    expect(T.hasBatchFlag('plink -batchx')).toBe(false)
  })
})

describe('resolveVariant (official St)', () => {
  test('explicit GIT_SSH_VARIANT maps plink/putty/simple/ssh', () => {
    expect(T.resolveVariant({ GIT_SSH_VARIANT: 'plink' }, 'x')).toBe('plink')
    expect(T.resolveVariant({ GIT_SSH_VARIANT: 'putty' }, 'x')).toBe('other')
    expect(T.resolveVariant({ GIT_SSH_VARIANT: 'tortoiseplink' }, 'x')).toBe(
      'other',
    )
    expect(T.resolveVariant({ GIT_SSH_VARIANT: 'simple' }, 'x')).toBe('other')
    expect(T.resolveVariant({ GIT_SSH_VARIANT: 'ssh' }, 'x')).toBe('ssh')
    expect(T.resolveVariant({ GIT_SSH_VARIANT: 'anything' }, 'x')).toBe('ssh')
  })
  test('auto / absent falls back to the command basename', () => {
    expect(T.resolveVariant({ GIT_SSH_VARIANT: 'auto' }, 'ssh')).toBe('ssh')
    expect(T.resolveVariant({}, '/usr/bin/plink')).toBe('plink')
    expect(T.resolveVariant({}, 'mywrapper')).toBe('other')
  })
})

describe('batchOptionsFor (official mt)', () => {
  test('ssh honors strictHostKeys; plink is -batch; other has none', () => {
    expect(T.batchOptionsFor('ssh', true)).toBe(STRICT)
    expect(T.batchOptionsFor('ssh', false)).toBe(BATCH_ONLY)
    expect(T.batchOptionsFor('plink', true)).toBe('-batch')
    expect(T.batchOptionsFor('other', true)).toBeUndefined()
  })
})

describe('inferVariant (official eKr)', () => {
  test('explicit non-auto config variant wins', () => {
    expect(T.inferVariant('plink', 'ssh')).toBe('plink')
  })
  test('auto/undefined infers from the chosen command basename', () => {
    expect(T.inferVariant(undefined, '/usr/bin/ssh -o X')).toBe('ssh')
    expect(T.inferVariant('auto', 'plink')).toBe('plink')
    expect(T.inferVariant(undefined, 'tortoiseplink')).toBe('tortoiseplink')
    expect(T.inferVariant(undefined, 'mywrapper')).toBe('auto')
  })
})

describe('resolveChosenAndNamed (official D) — resolution order', () => {
  test('GIT_SSH_COMMAND env beats config command', () => {
    const r = T.resolveChosenAndNamed(
      { GIT_SSH_COMMAND: 'envssh -i k' },
      'cfgssh',
    )
    expect(r.chosen).toBe('envssh -i k')
    expect(r.named).toBe('envssh')
  })
  test('config command is used when GIT_SSH_COMMAND env is blank/absent', () => {
    const r = T.resolveChosenAndNamed({}, 'cfgssh -i k')
    expect(r.chosen).toBe('cfgssh -i k')
    expect(r.named).toBe('cfgssh')
  })
  test('GIT_SSH env is shell-quoted and becomes both chosen and named', () => {
    const r = T.resolveChosenAndNamed({ GIT_SSH: '/my ssh' }, undefined)
    expect(r.chosen).toBe("'/my ssh'")
    expect(r.named).toBe('/my ssh')
  })
  test('falls back to plain ssh when nothing is set', () => {
    const r = T.resolveChosenAndNamed({}, undefined)
    expect(r.chosen).toBe('ssh')
    expect(r.named).toBeUndefined()
  })
})

describe('withSshCommand (official me)', () => {
  test('sets GIT_SSH_COMMAND and clears GIT_SSH', () => {
    const env = T.withSshCommand({ GIT_SSH: 'old', FOO: 'bar' }, 'ssh -o X')
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o X')
    expect(env.GIT_SSH).toBeUndefined()
    expect(env.FOO).toBe('bar')
  })
})

describe('resolveSshCommand (official X_n)', () => {
  test('default (no config) yields the strict ssh command + env', () => {
    const { command, env } = T.resolveSshCommand({}, undefined)
    expect(command).toBe(`ssh ${STRICT}`)
    expect(env.GIT_SSH_COMMAND).toBe(`ssh ${STRICT}`)
  })
  test('a custom ssh command gets the strict options appended', () => {
    const { command } = T.resolveSshCommand(
      { GIT_SSH_COMMAND: 'ssh -i ~/.ssh/id' },
      undefined,
    )
    expect(command).toBe(`ssh -i ~/.ssh/id ${STRICT}`)
  })
  test('a plink command gets -batch appended', () => {
    const { command } = T.resolveSshCommand({}, 'plink -i key.ppk')
    expect(command).toBe('plink -i key.ppk -batch')
  })
  test('a plink command that already has -batch is left unchanged (env untouched)', () => {
    const base = { GIT_SSH_COMMAND: 'plink -batch -i key.ppk' }
    const { command, env } = T.resolveSshCommand(base, undefined)
    expect(command).toBe('plink -batch -i key.ppk')
    expect(env).toBe(base)
  })
  test('an "other" variant appends nothing and returns the base env', () => {
    const base = { GIT_SSH_COMMAND: 'mywrapper --foo', GIT_SSH_VARIANT: 'simple' }
    const { command, env } = T.resolveSshCommand(base, undefined)
    expect(command).toBe('mywrapper --foo')
    expect(env).toBe(base)
  })
  test('strictHostKeys:false uses BatchMode only for ssh', () => {
    const { command } = T.resolveSshCommand({}, undefined, {
      strictHostKeys: false,
    })
    expect(command).toBe(`ssh ${BATCH_ONLY}`)
  })
})

describe('probeCandidate (official Tzo)', () => {
  test('undefined when the named command is already ssh/plink/tortoiseplink', () => {
    expect(T.probeCandidate({}, 'ssh -i k')).toBeUndefined()
    expect(T.probeCandidate({}, 'plink')).toBeUndefined()
  })
  test('returns the chosen command when the variant is genuinely ambiguous', () => {
    expect(T.probeCandidate({}, 'mywrapper --foo')).toBe('mywrapper --foo')
  })
  test('undefined when GIT_SSH_VARIANT is explicitly set (non-auto)', () => {
    expect(
      T.probeCandidate({ GIT_SSH_VARIANT: 'plink' }, 'mywrapper'),
    ).toBeUndefined()
  })
})

describe('cdWrapper (official eWt)', () => {
  test('wraps the command in a CDPATH-neutralized cd into the dir', () => {
    expect(T.cdWrapper('/home/u', 'ssh -G')).toBe(
      'CDPATH= cd -- /home/u 2>/dev/null || cd / || exit 1; ssh -G',
    )
  })
  test('quotes a dir with spaces', () => {
    expect(T.cdWrapper('/home/my user', 'ssh')).toContain("cd -- '/home/my user'")
  })
})

describe('safeHomeDir (official tWt)', () => {
  test('returns an absolute path', () => {
    expect(T.safeHomeDir().startsWith('/')).toBe(true)
  })
})

describe('resolvePluginGitSshEnv — integration (env var path)', () => {
  test('honors GIT_SSH_COMMAND from the caller env and appends strict options', async () => {
    // GIT_SSH_COMMAND is set, so the official CM ignores core.sshCommand from
    // config (env wins); the resolver appends the ssh variant's strict options.
    // GIT_CONFIG_GLOBAL/SYSTEM -> /dev/null keeps the config read deterministic.
    const baseEnv = {
      ...process.env,
      GIT_SSH_COMMAND: 'ssh -i ~/.ssh/custom_key',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    }
    const { command, env } = await resolvePluginGitSshEnv(
      'https://github.com/owner/repo.git',
      baseEnv,
    )
    expect(command).toBe(`ssh -i ~/.ssh/custom_key ${STRICT}`)
    expect(env.GIT_SSH_COMMAND).toBe(`ssh -i ~/.ssh/custom_key ${STRICT}`)
  })

  test('file:// URLs skip the config read and resolve to the strict ssh default', async () => {
    const baseEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    }
    delete baseEnv.GIT_SSH_COMMAND
    delete baseEnv.GIT_SSH
    const { command } = await resolvePluginGitSshEnv(
      'file:///tmp/local/repo',
      baseEnv,
    )
    expect(command).toBe(`ssh ${STRICT}`)
  })
})
