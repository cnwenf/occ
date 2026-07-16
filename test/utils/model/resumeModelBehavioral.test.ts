import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

/**
 * Real-code-path behavioral test for CC 2.1.211 Item 1:
 * "Fixed subagents spawned with an explicit model override reverting to
 * the parent's model when resumed or sent a follow-up message."
 *
 * This test drives the REAL `resumeAgentBackground` function with mocked
 * LEAF COLLABORATORS only (runAgent, registerAsyncAgent, runAsyncAgentLifecycle,
 * runWithAgentContext, assembleToolPool, runWithCwdOverride). The function
 * under test (resumeAgentBackground), getAgentModel, writeAgentMetadata, and
 * readAgentMetadata are all REAL.
 *
 * The mock `runAgent` captures the `model` parameter that resumeAgentBackground
 * passes to it — this is the exact value that determines the resumed agent's
 * effective model.
 *
 * On FIX (727ab61): model = isResumedFork ? undefined : meta?.model = 'sonnet'
 * On BASE (8b6a5d5): model = undefined (hardcoded)
 */

// --- REAL imports (before mocks — these stay real) ---
import { writeAgentMetadata } from 'src/utils/sessionStorage.js'
import { switchSession, setOriginalCwd } from 'src/bootstrap/state.js'
import { asAgentId } from 'src/types/ids.js'
import type { AgentId } from 'src/types/ids.js'
import type { ToolUseContext } from 'src/Tool.js'
import { getEmptyToolPermissionContext } from 'src/Tool.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'

// --- Mock setup for leaf collaborators ---
// Must be set up BEFORE importing resumeAgentBackground.

let capturedModel: string | undefined | null = null

// Mock runAgent — captures the model param from resumeAgentBackground
mock.module('src/tools/AgentTool/runAgent.js', () => ({
  runAgent: async function* (params: { model?: string }) {
    capturedModel = params.model
    yield
    return
  },
  filterIncompleteToolCalls: (messages: unknown[]) => messages,
}))

// Mock registerAsyncAgent — returns a fake background task
mock.module('src/tasks/LocalAgentTask/LocalAgentTask.js', () => ({
  registerAsyncAgent: () => ({
    agentId: 'test-agent-resume-001',
    abortController: new AbortController(),
  }),
}))

// Mock runAsyncAgentLifecycle — calls makeStream to trigger runAgent
mock.module('src/tools/AgentTool/agentToolUtils.js', () => ({
  runAsyncAgentLifecycle: async (opts: { makeStream: (p: unknown) => AsyncGenerator }) => {
    // Call makeStream immediately so the mock runAgent captures the model param
    const stream = opts.makeStream({})
    // Drain the async generator
    for await (const _msg of stream) {
      break
    }
  },
}))

// Mock runWithAgentContext — call the callback synchronously
mock.module('src/utils/agentContext.js', () => ({
  runWithAgentContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

// Mock runWithCwdOverride — call the function directly
mock.module('src/utils/cwd.js', () => ({
  runWithCwdOverride: (_cwd: string, fn: () => unknown) => fn(),
  getCwd: () => '/tmp',
}))

// Mock assembleToolPool — return empty tools
mock.module('src/tools.js', () => ({
  assembleToolPool: () => [],
}))

// --- Import resumeAgentBackground AFTER mocks are set up ---
const { resumeAgentBackground } = require('src/tools/AgentTool/resumeAgent.ts') as {
  resumeAgentBackground: (args: {
    agentId: string
    prompt: string
    toolUseContext: ToolUseContext
    canUseTool: () => Promise<boolean>
  }) => Promise<{ agentId: string; description: string; outputFile: string }>
}

// --- Helpers ---

function mkdtempSync(): string {
  const dir = join(tmpdir(), `occ-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

let tempDir: string

function setupTempSession(): { agentId: string; agentIdTyped: AgentId } {
  tempDir = mkdtempSync()
  const tempProjectDir = join(tempDir, 'project')
  const sessionId = 'test-session'
  const agentIdStr = 'test-agent-resume-001'
  mkdirSync(join(tempProjectDir, sessionId, 'subagents'), { recursive: true })
  setOriginalCwd(tempProjectDir)
  const agentIdTyped = asAgentId(agentIdStr)
  switchSession(sessionId as never, tempProjectDir)
  return { agentId: agentIdStr, agentIdTyped }
}

function writeTranscriptFile(agentId: string): void {
  // Write a minimal JSONL transcript file with one user message
  // The path matches getAgentTranscriptPath: <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl
  const transcriptDir = join(tempDir, 'project', 'test-session', 'subagents')
  const transcriptPath = join(transcriptDir, `agent-${agentId}.jsonl`)

  const msg = {
    uuid: randomUUID(),
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'test task' }],
    },
    cwd: tempDir,
    userType: 'external',
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    version: '2.1.270',
    parentUuid: null,
    isSidechain: true,
    agentId: agentId,
  }

  writeFileSync(transcriptPath, JSON.stringify(msg) + '\n')
}

function makeMinimalToolUseContext(): ToolUseContext {
  const abortController = new AbortController()
  const appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    mcp: { tools: [], clients: [], commands: [] },
    agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
    agent: undefined,
    effortValue: undefined,
    todos: {},
  } as never
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-opus-4-8-20250610',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' as const },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
    },
    abortController,
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appState,
    setAppState: () => {},
    setAppStateForTasks: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    messages: [],
    toolUseId: 'test-tool-use-id',
    contentReplacementState: undefined,
  } as unknown as ToolUseContext
}

// --- Tests ---

describe('① Resume model-override preservation — REAL resumeAgentBackground', () => {
  let agentId: string
  let agentIdTyped: AgentId

  beforeEach(() => {
    const setup = setupTempSession()
    agentId = setup.agentId
    agentIdTyped = setup.agentIdTyped
    capturedModel = null
  })

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('REAL resumeAgentBackground passes model override from metadata to runAgent', async () => {
    // Step 1: Write a real transcript file (so getAgentTranscript can read it)
    writeTranscriptFile(agentId)

    // Step 2: Use REAL writeAgentMetadata to persist model override
    await writeAgentMetadata(agentIdTyped, {
      agentType: 'general-purpose',
      model: 'sonnet',
    })

    // Step 3: Call REAL resumeAgentBackground
    // It will:
    //   - call REAL getAgentTranscript (reads the JSONL file)
    //   - call REAL readAgentMetadata (reads the .meta.json file with model='sonnet')
    //   - construct runAgentParams with model = isResumedFork ? undefined : meta?.model
    //   - call mock runAgent (leaf collaborator) which captures params.model
    const result = await resumeAgentBackground({
      agentId,
      prompt: 'follow up message',
      toolUseContext: makeMinimalToolUseContext(),
      canUseTool: async () => true,
    })

    expect(result).toBeDefined()
    expect(result.agentId).toBe(agentId)

    // The captured model is what resumeAgentBackground passed to runAgent.
    // FIX (727ab61): model = meta?.model = 'sonnet' (override preserved)
    // BASE (8b6a5d5): model = undefined (hardcoded — override lost)
    expect(capturedModel).toBe('sonnet')
  })

  test('REAL resumeAgentBackground passes undefined when metadata has no model', async () => {
    writeTranscriptFile(agentId)

    // Write metadata WITHOUT model field (backward compat / old-style)
    await writeAgentMetadata(agentIdTyped, {
      agentType: 'general-purpose',
    })

    const result = await resumeAgentBackground({
      agentId,
      prompt: 'follow up message',
      toolUseContext: makeMinimalToolUseContext(),
      canUseTool: async () => true,
    })

    expect(result).toBeDefined()
    // No model in metadata → meta?.model is undefined → model is undefined
    // (both base and fix agree on this — no override to preserve)
    expect(capturedModel).toBeUndefined()
  })
})
