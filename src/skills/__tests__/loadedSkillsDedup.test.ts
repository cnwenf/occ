import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import type { Command } from '../../commands.js'
import { processPromptSlashCommand } from '../../utils/processUserInput/processSlashCommand.js'
import {
  clearLoadedSkills,
  isSkillAlreadyLoaded,
  markSkillLoaded,
} from '../loadedSkillsTracker.js'
import { hashSkillContent } from '../../tools/SkillTool/skillAttribution.js'

/**
 * 2.1.202: re-invoking an already-loaded skill must NOT append a duplicate
 * copy of its instructions to context. Dedup is by name + content hash of the
 * rendered body, so an invocation with different args (different rendered
 * content) is still appended.
 */

// A unique marker baked into the stub skill body so we can detect whether the
// body was appended to the returned messages.
const BODY_MARKER = 'DEDUP_TEST_SKILL_BODY_xyzzy_marker_42'

/**
 * Build a stub prompt skill whose getPromptForCommand returns a fixed body
 * optionally suffixed with the args (so different args → different rendered
 * content → different content hash).
 */
function makeStubCommand(includeArgsInBody: boolean): Command {
  return {
    type: 'prompt',
    name: 'dedup-test-skill',
    description: 'stub skill for dedup test',
    userInvocable: true,
    source: 'userSettings',
    loadedFrom: 'skills',
    async getPromptForCommand(args: string) {
      const body = includeArgsInBody && args ? `${BODY_MARKER} ${args}` : BODY_MARKER
      return [{ type: 'text', text: body }]
    },
  } as unknown as Command
}

// Minimal context — CLAUDE_CODE_SIMPLE short-circuits attachment extraction
// before any deep context field is read, and the stub command ignores context.
const stubContext = { agentId: undefined } as unknown as ToolUseContext

/** Extract every text string from a message list (user message contents). */
function extractAllText(messages: Array<Record<string, unknown>>): string {
  const parts: string[] = []
  for (const msg of messages) {
    const inner = (msg as { message?: { content?: unknown } }).message
    const content = inner?.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && 'text' in block && typeof (block as { text: unknown }).text === 'string') {
          parts.push((block as { text: string }).text)
        }
      }
    }
  }
  return parts.join('\n')
}

describe('2.1.202 loadedSkillsTracker (pure)', () => {
  beforeEach(() => clearLoadedSkills())

  test('isSkillAlreadyLoaded is false before markSkillLoaded', () => {
    const h = hashSkillContent('body')
    expect(isSkillAlreadyLoaded('foo', h)).toBe(false)
  })

  test('markSkillLoaded makes the same name+hash loaded', () => {
    const h = hashSkillContent('body')
    markSkillLoaded('foo', h)
    expect(isSkillAlreadyLoaded('foo', h)).toBe(true)
  })

  test('different content hash is NOT considered loaded', () => {
    markSkillLoaded('foo', hashSkillContent('body-a'))
    expect(isSkillAlreadyLoaded('foo', hashSkillContent('body-b'))).toBe(false)
  })

  test('different name is NOT considered loaded (same hash)', () => {
    const h = hashSkillContent('body')
    markSkillLoaded('foo', h)
    expect(isSkillAlreadyLoaded('bar', h)).toBe(false)
  })

  test('clearLoadedSkills resets the tracker', () => {
    const h = hashSkillContent('body')
    markSkillLoaded('foo', h)
    expect(isSkillAlreadyLoaded('foo', h)).toBe(true)
    clearLoadedSkills()
    expect(isSkillAlreadyLoaded('foo', h)).toBe(false)
  })
})

describe('2.1.202 skill re-invoke dedup (behavioral)', () => {
  const prevSimple = process.env.CLAUDE_CODE_SIMPLE

  beforeEach(() => {
    clearLoadedSkills()
    // Short-circuit attachment extraction (no @-mentions here) so a minimal
    // context stub suffices and the test stays focused on instruction dedup.
    process.env.CLAUDE_CODE_SIMPLE = '1'
  })

  afterEach(() => {
    clearLoadedSkills()
    if (prevSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
    else process.env.CLAUDE_CODE_SIMPLE = prevSimple
  })

  test('second invoke of the same skill does NOT double-append instructions', async () => {
    const command = makeStubCommand(false)
    const commands = [command]

    // First invocation — instructions appended.
    const first = await processPromptSlashCommand(
      'dedup-test-skill',
      '',
      commands,
      stubContext,
    )
    const firstText = extractAllText(first.messages as Array<Record<string, unknown>>)
    expect(firstText.includes(BODY_MARKER)).toBe(true)

    // Second invocation — same skill, same rendered content → body MUST be
    // skipped (no duplicate copy of instructions appended).
    const second = await processPromptSlashCommand(
      'dedup-test-skill',
      '',
      commands,
      stubContext,
    )
    const secondText = extractAllText(second.messages as Array<Record<string, unknown>>)
    expect(secondText.includes(BODY_MARKER)).toBe(false)
    // The not-re-appended marker is present so the model knows instructions
    // were intentionally skipped.
    expect(secondText.includes('already loaded')).toBe(true)
  })

  test('invoke with different args (different rendered content) is still appended', async () => {
    const command = makeStubCommand(true)
    const commands = [command]

    const first = await processPromptSlashCommand(
      'dedup-test-skill',
      'args-one',
      commands,
      stubContext,
    )
    expect(
      extractAllText(first.messages as Array<Record<string, unknown>>).includes(
        `${BODY_MARKER} args-one`,
      ),
    ).toBe(true)

    // Different args → different rendered body → different content hash →
    // NOT a duplicate, so the body is appended again (no information lost).
    const second = await processPromptSlashCommand(
      'dedup-test-skill',
      'args-two',
      commands,
      stubContext,
    )
    expect(
      extractAllText(second.messages as Array<Record<string, unknown>>).includes(
        `${BODY_MARKER} args-two`,
      ),
    ).toBe(true)
  })
})
