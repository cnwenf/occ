import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman } from '../../utils/cron.js'
import { getCronJitterConfig } from '../../utils/cronJitterConfig.js'
import { listAllCronTasks, taskNextFireAt } from '../../utils/cronTasks.js'
import { truncate } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { nextRunUiSuffix } from './nextRunDisplay.js'
import {
  buildCronListPrompt,
  CRON_LIST_DESCRIPTION,
  CRON_LIST_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderListResultMessage, renderListToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    jobs: z.array(
      z.object({
        id: z.string(),
        cron: z.string(),
        humanSchedule: z.string(),
        prompt: z.string(),
        recurring: z.boolean().optional(),
        durable: z.boolean().optional(),
        // Official 2.1.299 (#074) `MLn` describe, byte-exact (v299 @248836603).
        nextFireAt: z
          .number()
          .optional()
          .describe(
            "Epoch ms of the job's next run, the scheduler's per-job offset included",
          ),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ListOutput = z.infer<OutputSchema>

export const CronListTool = buildTool({
  name: CRON_LIST_TOOL_NAME,
  searchHint: 'list active cron jobs',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return CRON_LIST_DESCRIPTION
  },
  async prompt() {
    return buildCronListPrompt(isDurableCronEnabled())
  },
  async call() {
    const allTasks = await listAllCronTasks()
    // Teammates only see their own crons; team lead (no ctx) sees all.
    const ctx = getTeammateContext()
    const tasks = ctx
      ? allTasks.filter(t => t.agentId === ctx.agentId)
      : allTasks
    // Official 2.1.299 (#074, v299 @248837000): `i=Yq(),s=Date.now(); …
    // a=e.nextFireAt??Iat(e,i); …a!==null&&{nextFireAt:Math.max(a,s)}` —
    // report the scheduler-accurate next run per job, clamped to now (a job
    // whose computed fire time already passed will fire on the next tick).
    const jitterCfg = getCronJitterConfig()
    const now = Date.now()
    const jobs = tasks.map(t => {
      const next = taskNextFireAt(t, jitterCfg)
      return {
        id: t.id,
        cron: t.cron,
        humanSchedule: cronToHuman(t.cron),
        prompt: t.prompt,
        ...(t.recurring ? { recurring: true } : {}),
        ...(t.durable === false ? { durable: false } : {}),
        ...(next !== null && { nextFireAt: Math.max(next, now) }),
      }
    })
    return { data: { jobs } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        output.jobs.length > 0
          ? output.jobs
              .map(
                j =>
                  `${j.id} — ${j.humanSchedule}${j.recurring ? ' (recurring)' : ' (one-shot)'}${j.durable === false ? ' [session-only]' : ''}${nextRunUiSuffix(j.nextFireAt)}: ${truncate(j.prompt, 80, true)}`,
              )
              .join('\n')
          : 'No scheduled jobs.',
    }
  },
  renderToolUseMessage: renderListToolUseMessage,
  renderToolResultMessage: renderListResultMessage,
} satisfies ToolDef<InputSchema, ListOutput>)
