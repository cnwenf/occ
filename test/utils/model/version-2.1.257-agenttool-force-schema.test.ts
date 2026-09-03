import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * Gap-113b — CLAUDE_CODE_SUBAGENT_MODEL_FORCE hides the AgentTool `model`
 * parameter from the tool schema (official 2.1.257, byte-verified `bpn`
 * wrapper in the 2.1.258 ELF: `a.CLAUDE_CODE_SUBAGENT_MODEL_FORCE
 * ? n.omit({model:!0}) : n`).
 *
 * lazySchema() memoizes forever AND buildTool() evaluates inputSchema()
 * eagerly at tool construction (src/Tool.ts), so the env var must be fixed
 * before the module graph first loads AgentTool. A plain in-process import
 * would therefore be order-dependent on whatever other test file ran first
 * in the same `bun test` process. Each branch is probed in its OWN spawned
 * `bun -e` process instead — deterministic under any runner (bare
 * `bun test`, scripts/ci-test.sh, single-file runs).
 */

const AGENT_TOOL_PATH = join(process.cwd(), 'src/tools/AgentTool/AgentTool.tsx')

const PROBE_SCRIPT = `
const { inputSchema } = await import(${JSON.stringify(AGENT_TOOL_PATH)})
console.log(JSON.stringify(Object.keys(inputSchema().shape)))
`

async function schemaKeysFor(envOverride: Record<string, string | undefined>): Promise<string[]> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(envOverride)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const proc = Bun.spawn(['bun', '-e', PROBE_SCRIPT], {
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ])
  expect(exitCode).toBe(0)
  const lastLine = stdout.trim().split('\n').pop() ?? ''
  return JSON.parse(lastLine) as string[]
}

describe('Gap-113b: AgentTool schema under CLAUDE_CODE_SUBAGENT_MODEL_FORCE', () => {
  test(
    'the model parameter is omitted from the schema shape under FORCE',
    async () => {
      const keys = await schemaKeysFor({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' })
      expect(keys).not.toContain('model')
      expect(keys).toContain('prompt')
      expect(keys).toContain('description')
      expect(keys).toContain('subagent_type')
    },
    30000,
  )

  test(
    'the model parameter is present without FORCE',
    async () => {
      const keys = await schemaKeysFor({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: undefined })
      expect(keys).toContain('model')
      expect(keys).toContain('prompt')
    },
    30000,
  )
})
