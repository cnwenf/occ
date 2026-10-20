/**
 * CC 2.1.304 #38 — SendMessage shutdown-approval guard
 * (docs/gap-research-304/research-R6-env-misc.md #38).
 *
 * Pre-fix, a main-session (or team-lead) model sending a structured
 * `shutdown_response` with approve:true fell straight through to
 * gracefulShutdown and killed the LEAD session itself. Official fix: only a
 * session actually running as a teammate may approve — guard at the top of
 * handleShutdownApproval with the verbatim message:
 *
 *   'Only a teammate can approve a shutdown request, and this session is not
 *    running as one. Nothing was sent. To shut down a teammate, send that
 *    teammate a shutdown_request message. The teammate is the one that
 *    approves it.'
 *
 * Official guard condition: teammateContext undefined && !isTeammate() → throw.
 * Plain `Error` matches OCC convention.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import * as REAL_MAILBOX_NS from '../../../utils/teammateMailbox.js'
import * as REAL_TEAMMATE_NS from '../../../utils/teammate.js'
import * as REAL_TEAMMATE_CTX_NS from '../../../utils/teammateContext.js'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// OCC-97 pattern: snapshot the real exports BEFORE mocking and restore them in
// afterAll — Bun's mock.module crosses file boundaries in the same worker.
const REAL_TEAMMATE_SNAPSHOT = { ...REAL_TEAMMATE_NS }
const REAL_TEAMMATE_CTX_SNAPSHOT = { ...REAL_TEAMMATE_CTX_NS }
const REAL_MAILBOX_SNAPSHOT = { ...REAL_MAILBOX_NS }
const REAL_SHUTDOWN_SNAPSHOT = {
  ...(await import('../../../utils/gracefulShutdown.js')),
}

const VERBATIM_GUARD_MESSAGE =
  'Only a teammate can approve a shutdown request, and this session is not running as one. Nothing was sent. To shut down a teammate, send that teammate a shutdown_request message. The teammate is the one that approves it.'

let mockIsTeammate = false
let mockTeamName: string | undefined
let mockAgentId: string | undefined
let mockAgentName: string | undefined
let mockTeammateContext: object | undefined

const shutdownCalls: unknown[][] = []
const mailboxCalls: Array<{ recipient: string; teamName?: string }> = []

await mock.module('../../../utils/teammate.js', () => ({
  ...REAL_TEAMMATE_SNAPSHOT,
  isTeammate: () => mockIsTeammate,
  getTeamName: () => mockTeamName,
  getAgentId: () => mockAgentId,
  getAgentName: () => mockAgentName,
  getTeammateColor: () => undefined,
  isTeamLead: () => false,
}))

await mock.module('../../../utils/teammateContext.js', () => ({
  ...REAL_TEAMMATE_CTX_SNAPSHOT,
  getTeammateContext: () => mockTeammateContext,
}))

await mock.module('../../../utils/gracefulShutdown.js', () => ({
  ...REAL_SHUTDOWN_SNAPSHOT,
  gracefulShutdown: async (...args: unknown[]) => {
    shutdownCalls.push(args)
  },
}))

await mock.module('../../../utils/teammateMailbox.js', () => ({
  ...REAL_MAILBOX_SNAPSHOT,
  writeToMailbox: async (
    recipient: string,
    _msg: unknown,
    teamName?: string,
  ) => {
    mailboxCalls.push({ recipient, teamName })
  },
}))

// The rest of the transitive graph (task modules, resumeAgent) loads for real
// — forkPermissionModeWiring285 proves it is importable in tests, and those
// paths are unreachable for structured shutdown_response messages anyway.

const { SendMessageTool } = await import('../SendMessageTool.js')

function shutdownApprovalInput() {
  return {
    to: 'team-lead',
    message: {
      type: 'shutdown_response' as const,
      request_id: 'r1',
      approve: true,
    },
  }
}

const fakeContext = {
  getAppState: () => ({ tasks: {}, agentNameRegistry: new Map() }),
}

async function callTool() {
  return await (SendMessageTool as any).call(
    shutdownApprovalInput(),
    fakeContext,
    undefined,
    undefined,
  )
}

async function flushImmediate(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 5))
}

beforeEach(() => {
  mockIsTeammate = false
  mockTeamName = undefined
  mockAgentId = undefined
  mockAgentName = undefined
  mockTeammateContext = undefined
  shutdownCalls.length = 0
  mailboxCalls.length = 0
})

afterEach(() => {
  mock.restore()
})

afterAll(() => {
  // Restore the real modules for every later test file in this worker
  // (OCC-97: Bun's mock.module crosses file boundaries).
  mock.module('../../../utils/teammate.js', () => ({
    ...REAL_TEAMMATE_SNAPSHOT,
  }))
  mock.module('../../../utils/teammateContext.js', () => ({
    ...REAL_TEAMMATE_CTX_SNAPSHOT,
  }))
  mock.module('../../../utils/gracefulShutdown.js', () => ({
    ...REAL_SHUTDOWN_SNAPSHOT,
  }))
  mock.module('../../../utils/teammateMailbox.js', () => ({
    ...REAL_MAILBOX_SNAPSHOT,
  }))
})

test('main session approving a shutdown_request throws the official verbatim message and does NOT shut down', async () => {
  // Arrange — main session: no teammate context, isTeammate() false.

  // Act & Assert
  await expect(callTool()).rejects.toThrow(VERBATIM_GUARD_MESSAGE)
  expect(mailboxCalls.length).toBe(0)
  expect(shutdownCalls.length).toBe(0)
})

test('team-lead session (isTeammate false, no context) is also refused — pre-fix it killed the lead', async () => {
  // Arrange — the lead session resolves names via getAgentName but is not a
  // teammate and carries no teammate context.
  mockAgentName = 'team-lead'

  // Act & Assert
  await expect(callTool()).rejects.toThrow(VERBATIM_GUARD_MESSAGE)
  expect(shutdownCalls.length).toBe(0)
})

test('teammate approval still works: mailbox confirmation + graceful self-exit', async () => {
  // Arrange
  mockIsTeammate = true
  mockAgentName = 'worker-1'

  // Act
  const result = await callTool()
  await flushImmediate()

  // Assert
  expect(result.data.success).toBe(true)
  expect(result.data.message).toBe(
    'Shutdown approved. Sent confirmation to team-lead. Agent worker-1 is now exiting.',
  )
  expect(mailboxCalls).toEqual([{ recipient: 'team-lead', teamName: undefined }])
  // The teammate's OWN process exit path is preserved (setImmediate).
  expect(shutdownCalls).toEqual([[0, 'other']])
})

test('in-process teammate (teammateContext present, isTeammate false) passes the guard', async () => {
  // Arrange — the official guard is `!teammateContext && !isTeammate()`.
  mockTeammateContext = {}
  mockAgentName = 'in-proc-worker'

  // Act
  const result = await callTool()
  await flushImmediate()

  // Assert
  expect(result.data.success).toBe(true)
  expect(mailboxCalls.length).toBe(1)
  expect(shutdownCalls).toEqual([[0, 'other']])
})
