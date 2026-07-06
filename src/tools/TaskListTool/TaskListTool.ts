import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getTaskListId,
  isTodoV2Enabled,
  listTasks,
  TaskStatusSchema,
} from '../../utils/tasks.js'
import { TASK_LIST_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    tasks: z.array(
      z.object({
        id: z.string(),
        subject: z.string(),
        status: TaskStatusSchema(),
        owner: z.string().optional(),
        blockedBy: z.array(z.string()),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TaskListTool = buildTool({
  name: TASK_LIST_TOOL_NAME,
  searchHint: 'list all tasks',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'TaskList'
  },
  shouldDefer: true,
  isEnabled() {
    return isTodoV2Enabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async call() {
    const taskListId = getTaskListId()

    const allTasks = (await listTasks(taskListId)).filter(
      t => !t.metadata?._internal,
    )

    // Build a set of resolved task IDs for filtering
    const resolvedTaskIds = new Set(
      allTasks.filter(t => t.status === 'completed').map(t => t.id),
    )

    const tasks = allTasks.map(task => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      owner: task.owner,
      blockedBy: task.blockedBy.filter(id => !resolvedTaskIds.has(id)),
    }))

    // claude-code 2.1.119: return tasks sorted by ID (numeric, lowest first)
    // so the list is deterministic and matches the "prefer tasks in ID order"
    // guidance given to the model. Falls back to lexicographic for non-numeric.
    tasks.sort((a, b) => {
      const na = Number(a.id)
      const nb = Number(b.id)
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    return {
      data: {
        tasks,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { tasks } = content as Output
    if (tasks.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No tasks found',
      }
    }

    const lines = tasks.map(task => {
      const owner = task.owner ? ` (${task.owner})` : ''
      const blocked =
        task.blockedBy.length > 0
          ? ` [blocked by ${task.blockedBy.map(id => `#${id}`).join(', ')}]`
          : ''
      return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`
    })

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
