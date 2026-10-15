/**
 * CC 2.1.299 #110 — `occ mcp add <name> -- <command> --background` must pass
 * EVERYTHING after `--` to the server command verbatim; flags after the
 * separator must NOT be interpreted as CLI/session flags.
 *
 * The live Commander path already handles `--` natively (addCommand.ts:82 —
 * "Commander.js handles -- natively"); this file is the regression test that
 * pins the contract. (The dead `cli.tsx` BG_SESSIONS raw `args.includes
 * ("--background")` scan is NOT `--`-aware, but BG_SESSIONS is not in the
 * FEATURE_ALLOWLIST so that path never executes.)
 *
 * Program wiring mirrors main.tsx :963 + :4415 + :4433 exactly:
 *   program.enablePositionalOptions(); program.command('mcp')
 *     .enablePositionalOptions(); registerMcpAddCommand(mcp)
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { Command } from '@commander-js/extra-typings'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- mocks (BEFORE importing addCommand.js) -------------------------------
const actualConfig = await import('../../../services/mcp/config.js')

type AddCall = { name: string; config: unknown; scope: string }
const addMcpConfigCalls: AddCall[] = []

mock.module('../../../services/mcp/config.js', () => ({
  ...actualConfig,
  addMcpConfig: async (name: string, config: unknown, scope: string) => {
    addMcpConfigCalls.push({ name, config, scope })
    return { success: true }
  },
}))

const { registerMcpAddCommand } = await import('../addCommand.js')

// --- harness ---------------------------------------------------------------
let tempDir: string
let originalConfigDir: string | undefined
let exitSpy: ReturnType<typeof spyOn>
let stdoutSpy: ReturnType<typeof spyOn>
let stderrSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  addMcpConfigCalls.length = 0
  tempDir = mkdtempSync(join(tmpdir(), 'occ-mcp-add-299-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir
  exitSpy = spyOn(process, 'exit').mockImplementation((() =>
    undefined) as never)
  stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((() =>
    true) as never)
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation((() =>
    true) as never)
})

afterEach(() => {
  exitSpy.mockRestore()
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  rmSync(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  // OCC-97: module mocks are process-global — always restore.
  mock.module('../../../services/mcp/config.js', () => ({ ...actualConfig }))
})

/** Mirrors main.tsx wiring; exitOverride so parse errors throw (subcommands
 * inherit _exitCallback at creation, commander v13 command.js:98). */
function buildProgram(): Command {
  const program = new Command().exitOverride().enablePositionalOptions()
  const mcp = program
    .command('mcp')
    .description('Configure and manage MCP servers')
    .exitOverride()
    .enablePositionalOptions()
  registerMcpAddCommand(mcp)
  return program
}

// --- tests -----------------------------------------------------------------
describe('#110 mcp add — everything after `--` belongs to the server command', () => {
  test('`mcp add x -- sleep 5 --background` → args exactly ["5","--background"], no session flag consumed', async () => {
    // Arrange
    const program = buildProgram()

    // Act
    await program.parseAsync([
      'node',
      'occ',
      'mcp',
      'add',
      'x',
      '--',
      'sleep',
      '5',
      '--background',
    ])

    // Assert — `--background` landed VERBATIM in the server args; Commander
    // never treated it as an OCC/session flag, and the stdio config is exact.
    expect(addMcpConfigCalls).toHaveLength(1)
    expect(addMcpConfigCalls[0]?.name).toBe('x')
    expect(addMcpConfigCalls[0]?.config).toEqual({
      type: 'stdio',
      command: 'sleep',
      args: ['5', '--background'],
      env: {},
    })
    expect(addMcpConfigCalls[0]?.scope).toBe('local')
    expect(exitSpy).toHaveBeenCalledWith(0) // cliOk success path
  })

  test('multiple post-`--` flags stay verbatim and in order', async () => {
    // Arrange
    const program = buildProgram()

    // Act
    await program.parseAsync([
      'node',
      'occ',
      'mcp',
      'add',
      'srv',
      '--',
      'my-cmd',
      '--verbose',
      '--scope',
      'user',
      '--bg',
    ])

    // Assert
    expect(addMcpConfigCalls).toHaveLength(1)
    expect(addMcpConfigCalls[0]?.config).toEqual({
      type: 'stdio',
      command: 'my-cmd',
      args: ['--verbose', '--scope', 'user', '--bg'],
      env: {},
    })
  })

  test('options BEFORE `--` still work (`-s user` applies, post-`--` flag stays an arg)', async () => {
    // Arrange
    const program = buildProgram()

    // Act
    await program.parseAsync([
      'node',
      'occ',
      'mcp',
      'add',
      '-s',
      'user',
      'srv',
      '--',
      'sleep',
      '5',
      '--background',
    ])

    // Assert
    expect(addMcpConfigCalls).toHaveLength(1)
    expect(addMcpConfigCalls[0]?.scope).toBe('user')
    expect(addMcpConfigCalls[0]?.config).toEqual({
      type: 'stdio',
      command: 'sleep',
      args: ['5', '--background'],
      env: {},
    })
  })

  test('WITHOUT `--`, a `--background` flag is NOT a server arg (unknown option → no add)', async () => {
    // Arrange — pins the contrast: the separator is what protects the flag
    const program = buildProgram()

    // Act / Assert — Commander rejects the undeclared option; addMcpConfig
    // is never reached, so `--background` can never silently become an arg.
    await expect(
      program.parseAsync([
        'node',
        'occ',
        'mcp',
        'add',
        'x',
        'sleep',
        '5',
        '--background',
      ]),
    ).rejects.toThrow()
    expect(addMcpConfigCalls).toHaveLength(0)
  })
})
