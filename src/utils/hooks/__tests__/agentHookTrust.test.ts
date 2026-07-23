import { describe, expect, test, beforeEach, mock, spyOn } from 'bun:test'
import {
  resolveAgentTrustRoot,
  isAgentHooksOriginTrusted,
  hasFrontmatterHooks,
  getAgentHookTrustKey,
  sanitizeTrustKey,
} from '../../../tools/AgentTool/loadAgentsDir'
import type { HooksSettings } from '../../settings/types'
import { getGlobalConfig } from '../../config'

/**
 * CC 2.1.218 #23: agent frontmatter hooks must NOT run from untrusted folders.
 * Hooks now require the agent file's OWN folder to be trusted (prevents a
 * malicious agent file dropped in an untrusted dir from running hooks).
 *
 * Strings reverse-engineered from the official 2.1.218 ELF:
 *
 *   dAo(agentDef) → trust check:
 *     - source in [plugin, policySettings, built-in, builtin, bundled] → true
 *     - source is userSettings or flagSettings → true
 *     - no baseDir → checkHasTrustDialogAccepted() (CWD trust)
 *     - otherwise → isPathTrusted(osd(baseDir))
 *
 *   osd(baseDir) → resolve trust root:
 *     - if baseDir is <project>/.claude/agents → <project>
 *     - otherwise → baseDir as-is
 *
 *   pAo(agentDef, surface) → skip message:
 *     "Skipping frontmatter hooks for {n} '{o}': the folder its definition
 *     file came from is not trusted (source: {source}, trust key: {key}).
 *     Run Claude Code there once and accept the trust dialog, or set
 *     projects[{key}].hasTrustDialogAccepted: true in {configPath}."
 *
 *   telemetry: tengu_agent_hooks_origin_untrusted
 *     { source, surface, fromAdditionalDirectory }
 */

describe('CC 2.1.218 #23: resolveAgentTrustRoot (osd)', () => {
  test('.claude/agents resolves to project root', () => {
    expect(resolveAgentTrustRoot('/my-project/.claude/agents')).toBe(
      '/my-project',
    )
  })

  test('nested .claude/agents still resolves', () => {
    expect(resolveAgentTrustRoot('/a/b/.claude/agents')).toBe('/a/b')
  })

  test('non-agents directory returns as-is', () => {
    expect(resolveAgentTrustRoot('/some/random/dir')).toBe('/some/random/dir')
  })

  test('.claude directory (without agents) returns as-is', () => {
    expect(resolveAgentTrustRoot('/my-project/.claude')).toBe(
      '/my-project/.claude',
    )
  })

  test('agents directory without .claude parent returns as-is', () => {
    expect(resolveAgentTrustRoot('/foo/agents')).toBe('/foo/agents')
  })
})

describe('CC 2.1.218 #23: hasFrontmatterHooks (fAo)', () => {
  test('undefined hooks → false', () => {
    expect(hasFrontmatterHooks(undefined)).toBe(false)
  })

  test('empty hooks object → false', () => {
    expect(hasFrontmatterHooks({} as HooksSettings)).toBe(false)
  })

  test('hooks with empty arrays → false', () => {
    expect(
      hasFrontmatterHooks({ Stop: [{ matcher: '', hooks: [] }] }),
    ).toBe(false)
  })

  test('hooks with actual entries → true', () => {
    expect(
      hasFrontmatterHooks({
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'echo hi' }],
          },
        ],
      }),
    ).toBe(true)
  })
})

describe('CC 2.1.218 #23: isAgentHooksOriginTrusted (dAo)', () => {
  beforeEach(() => {
    // Reset global config projects to empty
    const config = getGlobalConfig()
    config.projects = {}
  })

  test('plugin source → trusted', () => {
    expect(
      isAgentHooksOriginTrusted({ source: 'plugin', baseDir: '/untrusted' }),
    ).toBe(true)
  })

  test('built-in source → trusted', () => {
    expect(
      isAgentHooksOriginTrusted({ source: 'built-in', baseDir: 'built-in' }),
    ).toBe(true)
  })

  test('policySettings source → trusted', () => {
    expect(
      isAgentHooksOriginTrusted({
        source: 'policySettings',
        baseDir: '/untrusted',
      }),
    ).toBe(true)
  })

  test('userSettings source → trusted (even from untrusted dir)', () => {
    expect(
      isAgentHooksOriginTrusted({
        source: 'userSettings',
        baseDir: '/untrusted/.claude/agents',
      }),
    ).toBe(true)
  })

  test('flagSettings source → trusted', () => {
    expect(
      isAgentHooksOriginTrusted({
        source: 'flagSettings',
        baseDir: '/untrusted',
      }),
    ).toBe(true)
  })

  test('projectSettings source with trusted folder → trusted', () => {
    const config = getGlobalConfig()
    config.projects = {
      '/trusted': { hasTrustDialogAccepted: true },
    }
    expect(
      isAgentHooksOriginTrusted({
        source: 'projectSettings',
        baseDir: '/trusted/.claude/agents',
      }),
    ).toBe(true)
  })

  test('projectSettings source with untrusted folder → NOT trusted', () => {
    // Ensure /untrusted is NOT in projects
    const config = getGlobalConfig()
    config.projects = {}
    expect(
      isAgentHooksOriginTrusted({
        source: 'projectSettings',
        baseDir: '/untrusted/.claude/agents',
      }),
    ).toBe(false)
  })

  test('localSettings source with untrusted folder → NOT trusted', () => {
    const config = getGlobalConfig()
    config.projects = {}
    expect(
      isAgentHooksOriginTrusted({
        source: 'localSettings',
        baseDir: '/untrusted/.claude/agents',
      }),
    ).toBe(false)
  })

  test('localSettings source with trusted folder → trusted', () => {
    const config = getGlobalConfig()
    config.projects = {
      '/trusted': { hasTrustDialogAccepted: true },
    }
    expect(
      isAgentHooksOriginTrusted({
        source: 'localSettings',
        baseDir: '/trusted/.claude/agents',
      }),
    ).toBe(true)
  })
})

describe('CC 2.1.218 #23: getAgentHookTrustKey (vIy/oW)', () => {
  test('with baseDir resolves trust root', () => {
    const key = getAgentHookTrustKey({
      baseDir: '/my-project/.claude/agents',
    })
    expect(key).toBe('/my-project')
  })

  test('without baseDir resolves CWD', () => {
    const key = getAgentHookTrustKey({})
    // Should be the normalized CWD path
    expect(typeof key).toBe('string')
    expect(key.length).toBeGreaterThan(0)
  })
})

describe('CC 2.1.218 #23: sanitizeTrustKey (nsd)', () => {
  test('plain path passes through', () => {
    expect(sanitizeTrustKey('/my/project')).toBe('/my/project')
  })

  test('control chars are escaped', () => {
    // U+007F (DEL) should be escaped to 
    const result = sanitizeTrustKey('/badpath')
    expect(result).toContain('\\u007f')
    expect(result).not.toContain('')
  })
})

describe('CC 2.1.218 #23: skipFrontmatterHooksForUntrustedOrigin (pAo)', () => {
  test('logs the official verbatim message for subagent surface', async () => {
    const hooks = await import('../../hooks')
    const debug = await import('../../debug')
    const debugSpy = spyOn(debug, 'logForDebugging').mockImplementation(
      () => {},
    )

    const config = getGlobalConfig()
    config.projects = {}

    hooks.skipFrontmatterHooksForUntrustedOrigin(
      {
        agentType: 'my-agent',
        source: 'projectSettings',
        baseDir: '/untrusted/.claude/agents',
      },
      'subagent',
    )

    expect(debugSpy).toHaveBeenCalled()
    const message = debugSpy.mock.calls[0][0] as string
    // Verify the verbatim structure from the official binary
    expect(message).toContain("Skipping frontmatter hooks for agent 'my-agent'")
    expect(message).toContain(
      'the folder its definition file came from is not trusted',
    )
    expect(message).toContain('source: projectSettings')
    expect(message).toContain('trust key: /untrusted')
    expect(message).toContain(
      'Run Claude Code there once and accept the trust dialog',
    )
    expect(message).toContain(
      'projects[/untrusted].hasTrustDialogAccepted: true',
    )

    debugSpy.mockRestore()
  })

  test('logs "main-thread agent" for mainThread surface', async () => {
    const hooks = await import('../../hooks')
    const debug = await import('../../debug')
    const debugSpy = spyOn(debug, 'logForDebugging').mockImplementation(
      () => {},
    )

    const config = getGlobalConfig()
    config.projects = {}

    hooks.skipFrontmatterHooksForUntrustedOrigin(
      {
        agentType: 'main-agent',
        source: 'projectSettings',
        baseDir: '/untrusted/.claude/agents',
      },
      'mainThread',
    )

    expect(debugSpy).toHaveBeenCalled()
    const message = debugSpy.mock.calls[0][0] as string
    expect(message).toContain('main-thread agent')

    debugSpy.mockRestore()
  })
})
