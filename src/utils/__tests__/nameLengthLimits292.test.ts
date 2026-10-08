import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { basename } from 'node:path'
import * as debug from '../debug.js'
import { NAME_MAX_LENGTH, validateFrontmatterName } from '../nameSafety.js'
import { parseSkillFrontmatterFields } from '../../skills/loadSkillsDir.js'
import {
  getParseError,
  parseAgentFromMarkdown,
} from '../../tools/AgentTool/loadAgentsDir.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.292 (cluster-c-h-carryover §C6): 256-character name limits.
 *
 * Official shared constant (@207344922): `iY=256`.
 * Frontmatter ignorer M4t (@207586013):
 *   function M4t(e,n){if(e==null)return;let r=String(e);if(r.length<=iY)return r;
 *     t(`Frontmatter "name" of ${n} is over ${iY} characters - ignoring it`,{level:"warn"});return}
 * Agent rejection site 1 BFo (@213518427, frontmatter parse error):
 *   `Invalid "name": names must be at most ${iY} characters`
 * Agent rejection site 2 EXn (@213521927, loader):
 *   `Agent file ${path} has invalid name '${name}': names must be at most ${iY} characters` (level error, returns null)
 *
 * OCC mapping: NAME_MAX_LENGTH ≡ iY, validateFrontmatterName ≡ M4t.
 * Sites: loadAgentsDir (getParseError + parseAgentFromMarkdown) reject;
 * skills (parseSkillFrontmatterFields displayName) + plugin agents ignore+warn.
 */

const name255 = 'a'.repeat(255)
const name256 = 'a'.repeat(256)
const name257 = 'a'.repeat(257)

let logs: { message: string; level?: string }[] = []
let spy: ReturnType<typeof spyOn> | undefined

function captureLogs() {
  logs = []
  spy = spyOn(debug, 'logForDebugging').mockImplementation(
    (message: string, opts?: { level?: string }) => {
      logs.push({ message, level: opts?.level })
      return undefined as never
    },
  )
}

afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

// --- shared util (M4t) ----------------------------------------------------

describe('NAME_MAX_LENGTH shared constant', () => {
  test('is 256 (official iY)', () => {
    expect(NAME_MAX_LENGTH).toBe(256)
  })
})

describe('validateFrontmatterName (M4t)', () => {
  test('returns null-ish input as undefined without warning', () => {
    captureLogs()
    expect(validateFrontmatterName(null, 'skill x')).toBeUndefined()
    expect(validateFrontmatterName(undefined, 'skill x')).toBeUndefined()
    expect(logs.length).toBe(0)
  })

  test('255-char name is returned unchanged', () => {
    captureLogs()
    expect(validateFrontmatterName(name255, 'skill x')).toBe(name255)
    expect(logs.length).toBe(0)
  })

  test('256-char name (boundary) is returned unchanged', () => {
    captureLogs()
    expect(validateFrontmatterName(name256, 'skill x')).toBe(name256)
    expect(logs.length).toBe(0)
  })

  test('257-char name is ignored + warned with the official message', () => {
    captureLogs()
    expect(validateFrontmatterName(name257, 'skill x')).toBeUndefined()
    expect(logs.length).toBe(1)
    expect(logs[0]?.message).toBe(
      'Frontmatter "name" of skill x is over 256 characters - ignoring it',
    )
    expect(logs[0]?.level).toBe('warn')
  })

  test('coerces non-string values via String()', () => {
    captureLogs()
    expect(validateFrontmatterName(12345, 'plugin agent y')).toBe('12345')
  })
})

// --- agent site 1: getParseError (BFo) ------------------------------------

describe('getParseError rejects over-long agent names (BFo)', () => {
  test('256-char name is not rejected for length', () => {
    expect(getParseError({ name: name256, description: 'd' })).toBe(
      'Unknown parsing error',
    )
  })

  test('257-char name → official BFo message', () => {
    expect(getParseError({ name: name257, description: 'd' })).toBe(
      'Invalid "name": names must be at most 256 characters',
    )
  })

  test('length is checked before the ":" reject (official order)', () => {
    // 257 chars including a ":" — length must win per BFo order.
    const longWithColon = `${'a'.repeat(256)}:` // 257 chars, contains ":"
    expect(longWithColon.length).toBe(257)
    expect(getParseError({ name: longWithColon, description: 'd' })).toBe(
      'Invalid "name": names must be at most 256 characters',
    )
  })
})

// --- agent site 2: parseAgentFromMarkdown (EXn) ---------------------------

describe('parseAgentFromMarkdown rejects over-long agent names (EXn)', () => {
  test('256-char name loads', () => {
    captureLogs()
    const agent = parseAgentFromMarkdown(
      '/x/.claude/agents/ok.md',
      '/x/.claude/agents',
      { name: name256, description: 'demo' },
      'body',
      'projectSettings',
    )
    expect(agent).not.toBeNull()
    expect((agent as { agentType?: string }).agentType).toBe(name256)
  })

  test('257-char name → null + official EXn error log', () => {
    captureLogs()
    const agent = parseAgentFromMarkdown(
      '/x/.claude/agents/bad.md',
      '/x/.claude/agents',
      { name: name257, description: 'demo' },
      'body',
      'projectSettings',
    )
    expect(agent).toBeNull()
    const line = logs.find(l => l.message.includes('has invalid name'))
    expect(line?.message).toBe(
      `Agent file /x/.claude/agents/bad.md has invalid name '${name257}': names must be at most 256 characters`,
    )
    expect(line?.level).toBe('error')
  })
})

// --- skill site: parseSkillFrontmatterFields displayName ------------------

describe('skill frontmatter name >256 is ignored + warned', () => {
  test('256-char name → displayName kept', () => {
    captureLogs()
    const parsed = parseSkillFrontmatterFields(
      { name: name256 } as never,
      'body',
      'my-skill',
    )
    expect(parsed.displayName).toBe(name256)
  })

  test('257-char name → displayName undefined + official warn', () => {
    captureLogs()
    const parsed = parseSkillFrontmatterFields(
      { name: name257 } as never,
      'body',
      'my-skill',
    )
    expect(parsed.displayName).toBeUndefined()
    expect(
      logs.some(
        l =>
          l.message ===
          'Frontmatter "name" of skill my-skill is over 256 characters - ignoring it',
      ),
    ).toBe(true)
  })
})

// --- plugin agent site: filename fallback ---------------------------------

describe('plugin agent over-long name falls back to filename', () => {
  // Mirrors loadPluginAgents.ts:88-89 composition:
  //   validateFrontmatterName(frontmatter.name, `plugin agent ${filePath}`)
  //     || basename(filePath).replace(/\.md$/, '')
  function resolvePluginAgentName(
    frontmatterName: unknown,
    filePath: string,
  ): string {
    return (
      validateFrontmatterName(frontmatterName, `plugin agent ${filePath}`) ||
      basename(filePath).replace(/\.md$/, '')
    )
  }

  test('256-char name is used verbatim', () => {
    captureLogs()
    expect(resolvePluginAgentName(name256, '/p/agents/helper.md')).toBe(name256)
  })

  test('257-char name → filename stem + official warn', () => {
    captureLogs()
    expect(resolvePluginAgentName(name257, '/p/agents/helper.md')).toBe('helper')
    expect(
      logs.some(
        l =>
          l.message ===
          'Frontmatter "name" of plugin agent /p/agents/helper.md is over 256 characters - ignoring it',
      ),
    ).toBe(true)
  })

  test('missing name → filename stem, no warn', () => {
    captureLogs()
    expect(resolvePluginAgentName(undefined, '/p/agents/helper.md')).toBe(
      'helper',
    )
    expect(logs.length).toBe(0)
  })
})
