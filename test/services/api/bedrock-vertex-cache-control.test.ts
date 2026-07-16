import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  buildSystemPromptBlocks,
  getCacheControl,
} from '../../../src/services/api/claude.js'
import { appendSystemContext } from '../../../src/utils/api.js'

/**
 * Binary recon (CC 2.1.210 → 2.1.211):
 *
 * The 2.1.211 CHANGELOG states: "Fixed a prompt-caching regression on
 * Bedrock, Vertex, Mantle, and Foundry that billed the trailing system
 * context block as fresh input tokens on every request."
 *
 * The upstream fix is in the message-to-API-param conversion function
 * (minified `Nny` in 210, equivalent in 211), specifically in the
 * condition variable that gates `cache_control` on `api_system` messages
 * (messages sent as `{ role: "system" }` in the messages array):
 *
 *   210: let a = fB() && E8t() && _Zu()
 *        // fB()=shouldIncludeFirstPartyOnlyBetas(), _Zu()=shouldUseGlobalCacheScope()
 *        // → false for bedrock/vertex/mantle/foundry → no cache_control on api_system
 *
 *   211: let c = AB() && a8t(l) && srd()
 *        || !WAe() && (
 *             l==="bedrock"   && ANTHROPIC_BEDROCK_BASE_URL===undefined  ||
 *             l==="vertex"    && ANTHROPIC_VERTEX_BASE_URL===undefined   ||
 *             l==="mantle"    && ANTHROPIC_BEDROCK_MANTLE_BASE_URL===undefined ||
 *             l==="foundry"   && Ysy()
 *           )
 *        // → extends cache_control to bedrock/vertex/mantle/foundry
 *
 * OCC state finding: OCC does NOT have the `api_system` message type.
 * OCC's message types are 'user'|'assistant'|'system'|'attachment'|
 * 'progress'|'grouped_tool_use'|'collapsed_read_search'. The binary's
 * `api_system` type (created by `x2y(e)` → `{type:"api_system",message:
 * {role:"system",content:e}}`) has no OCC equivalent. OCC handles system
 * context via `appendSystemContext()` → `buildSystemPromptBlocks()`,
 * which already places `cache_control` on the trailing system block for
 * ALL providers (including bedrock/vertex).
 *
 * Conclusion: the 2.1.211 fix targets a code path (`api_system` message
 * cache_control) that doesn't exist in OCC. OCC's existing
 * `buildSystemPromptBlocks` already correctly places cache_control on
 * the trailing system-context block for bedrock/vertex. These tests
 * verify that existing behavior so a future refactor doesn't regress it.
 */

// --- Environment helpers -------------------------------------------------

const PREV_PROVIDER = process.env.CLAUDE_CODE_USE_BEDROCK
const PREV_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX
const PREV_DISABLE = process.env.DISABLE_PROMPT_CACHING

function setProvider(provider: 'bedrock' | 'vertex' | 'firstParty'): void {
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.DISABLE_PROMPT_CACHING
  if (provider === 'bedrock') {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  } else if (provider === 'vertex') {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
  }
}

beforeEach(() => {
  // Ensure prompt caching is not globally disabled
  delete process.env.DISABLE_PROMPT_CACHING
  delete process.env.FORCE_PROMPT_CACHING_5M
})

afterEach(() => {
  // Restore env
  if (PREV_PROVIDER !== undefined) {
    process.env.CLAUDE_CODE_USE_BEDROCK = PREV_PROVIDER
  } else {
    delete process.env.CLAUDE_CODE_USE_BEDROCK
  }
  if (PREV_VERTEX !== undefined) {
    process.env.CLAUDE_CODE_USE_VERTEX = PREV_VERTEX
  } else {
    delete process.env.CLAUDE_CODE_USE_VERTEX
  }
  if (PREV_DISABLE !== undefined) {
    process.env.DISABLE_PROMPT_CACHING = PREV_DISABLE
  } else {
    delete process.env.DISABLE_PROMPT_CACHING
  }
})

// --- Tests ----------------------------------------------------------------

describe('buildSystemPromptBlocks — trailing system-context block cache_control (CC 2.1.211 alignment)', () => {
  test('trailing system-context block carries cache_control for bedrock provider', () => {
    // Arrange: set provider to bedrock
    setProvider('bedrock')

    // Build a system prompt with trailing system context (same flow as
    // query.ts → appendSystemContext → buildSystemPromptBlocks)
    const baseSystemPrompt = [
      'x-anthropic-billing-header: cc_version=2.1.211',
      'You are Claude Code.',
    ]
    const systemContext = { cwd: '/home/user/project', model: 'claude-sonnet-4-20250514' }
    const fullSystemPrompt = appendSystemContext(baseSystemPrompt, systemContext)

    // Act: build the API system blocks with prompt caching enabled
    const blocks = buildSystemPromptBlocks(fullSystemPrompt, true, {})

    // Assert: the trailing (last) block must carry cache_control so it
    // is NOT re-billed as fresh input tokens on every request.
    expect(blocks.length).toBeGreaterThan(0)
    const trailingBlock = blocks[blocks.length - 1]
    expect(trailingBlock).toBeDefined()
    expect(trailingBlock.cache_control).toBeDefined()
    expect(trailingBlock.cache_control).toEqual({
      type: 'ephemeral',
    })
    // The trailing block should contain the system context
    expect(typeof trailingBlock.text).toBe('string')
    expect(trailingBlock.text).toContain('cwd: /home/user/project')
  })

  test('trailing system-context block carries cache_control for vertex provider', () => {
    // Arrange: set provider to vertex
    setProvider('vertex')

    const baseSystemPrompt = [
      'x-anthropic-billing-header: cc_version=2.1.211',
      'You are Claude Code.',
    ]
    const systemContext = { cwd: '/home/user/project', model: 'claude-sonnet-4-20250514' }
    const fullSystemPrompt = appendSystemContext(baseSystemPrompt, systemContext)

    // Act
    const blocks = buildSystemPromptBlocks(fullSystemPrompt, true, {})

    // Assert: the trailing block must carry cache_control for vertex
    expect(blocks.length).toBeGreaterThan(0)
    const trailingBlock = blocks[blocks.length - 1]
    expect(trailingBlock.cache_control).toBeDefined()
    expect(trailingBlock.cache_control).toEqual({
      type: 'ephemeral',
    })
  })

  test('attribution header does NOT carry cache_control (cacheScope null)', () => {
    // Arrange
    setProvider('bedrock')

    const baseSystemPrompt = [
      'x-anthropic-billing-header: cc_version=2.1.211',
      'You are Claude Code.',
    ]
    const systemContext = { cwd: '/home/user/project' }
    const fullSystemPrompt = appendSystemContext(baseSystemPrompt, systemContext)

    // Act
    const blocks = buildSystemPromptBlocks(fullSystemPrompt, true, {})

    // Assert: the first block (attribution header) should NOT have cache_control
    expect(blocks.length).toBeGreaterThan(1)
    const firstBlock = blocks[0]
    expect(firstBlock.cache_control).toBeUndefined()
  })

  test('prompt caching disabled → no cache_control on any block', () => {
    // Arrange
    setProvider('bedrock')

    const baseSystemPrompt = [
      'x-anthropic-billing-header: cc_version=2.1.211',
      'You are Claude Code.',
    ]
    const systemContext = { cwd: '/home/user/project' }
    const fullSystemPrompt = appendSystemContext(baseSystemPrompt, systemContext)

    // Act: build with prompt caching DISABLED
    const blocks = buildSystemPromptBlocks(fullSystemPrompt, false, {})

    // Assert: no block should have cache_control
    for (const block of blocks) {
      expect(block.cache_control).toBeUndefined()
    }
  })

  test('getCacheControl returns ephemeral type for org scope', () => {
    // Verify the cache_control object shape matches upstream
    const cc = getCacheControl({ scope: 'org' })
    expect(cc).toEqual({ type: 'ephemeral' })
  })

  test('getCacheControl returns ephemeral type without scope by default', () => {
    const cc = getCacheControl({})
    expect(cc).toEqual({ type: 'ephemeral' })
  })
})
