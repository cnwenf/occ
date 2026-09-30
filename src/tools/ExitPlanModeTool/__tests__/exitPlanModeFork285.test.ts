import { describe, expect, test } from 'bun:test'
import { FORK_SUBAGENT_TYPE } from '../../AgentTool/forkSubagent.js'
import { ExitPlanModeV2Tool } from '../ExitPlanModeV2Tool.js'

/**
 * CC 2.1.285 (security): "…a fork now runs under its parent's permission mode
 * and cannot exit plan mode."
 *
 * Official v285 ExitPlanMode validateInput first branch (decompiled ELF):
 *   `if(agentContext.agentType==="subagent"&&agentContext.isBuiltIn===!0
 *       &&agentContext.subagentName===bF&&(Wa()||permissions().mode==="plan"))
 *      return{result:!1,message:"A fork cannot exit plan mode; that belongs to
 *      the session that forked it. Finish your part and report back.",
 *      errorCode:2}`
 * OCC keys fork identity on ToolUseContext `agentType === FORK_SUBAGENT_TYPE`
 * (FORK_AGENT is source:'built-in', so the official isBuiltIn holds
 * implicitly); `Wa()` = isTeammate() (false in this harness).
 */

const FORK_REFUSAL_MESSAGE =
  'A fork cannot exit plan mode; that belongs to the session that forked it. Finish your part and report back.'

function makeContext(mode: string, agentType?: string) {
  return {
    getAppState: () => ({ toolPermissionContext: { mode } }),
    options: {},
    agentType,
  } as never
}

function validate(mode: string, agentType?: string) {
  return ExitPlanModeV2Tool.validateInput(
    {} as never,
    makeContext(mode, agentType),
  )
}

describe('ExitPlanMode fork refusal (CC 2.1.285)', () => {
  test('fork in plan mode is refused with errorCode 2 and the byte-exact message', async () => {
    const result = await validate('plan', FORK_SUBAGENT_TYPE)
    expect(result.result).toBe(false)
    expect(result.message).toBe(FORK_REFUSAL_MESSAGE)
    expect((result as { errorCode?: number }).errorCode).toBe(2)
  })

  test('fork outside plan mode falls through to the standard not-in-plan refusal (errorCode 1)', async () => {
    // Official first branch requires Wa()||mode==="plan"; a non-teammate fork
    // in 'default' mode reaches the generic mode!=='plan' refusal instead.
    const result = await validate('default', FORK_SUBAGENT_TYPE)
    expect(result.result).toBe(false)
    expect((result as { errorCode?: number }).errorCode).toBe(1)
  })

  test('main session in plan mode still validates successfully', async () => {
    const result = await validate('plan', undefined)
    expect(result.result).toBe(true)
  })

  test('non-fork subagent in plan mode is not caught by the fork branch', async () => {
    const result = await validate('plan', 'general-purpose')
    expect(result.result).toBe(true)
  })

  test('main session outside plan mode keeps the errorCode 1 refusal', async () => {
    const result = await validate('default', undefined)
    expect(result.result).toBe(false)
    expect((result as { errorCode?: number }).errorCode).toBe(1)
  })
})
