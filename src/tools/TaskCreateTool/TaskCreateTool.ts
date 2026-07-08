import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  executeTaskCreatedHooks,
  getTaskCreatedHookMessage,
} from '../../utils/hooks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  createTask,
  deleteTask,
  getTaskListId,
  isTodoV2Enabled,
} from '../../utils/tasks.js'
import { getAgentName, getTeamName } from '../../utils/teammate.js'
import { TASK_CREATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    subject: z.string().describe('A brief title for the task'),
    description: z.string().describe('What needs to be done'),
    activeForm: z
      .string()
      .optional()
      .describe(
        'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
      ),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Arbitrary metadata to attach to the task'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),
      subject: z.string(),
    }),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// ---- Input auto-repair (claude-code 2.1.169 parity) ---------------------
// The model occasionally calls TaskCreate with the wrong shape:
//   - TodoWrite-style `tasks`/`todos` array (cannot be repaired — steer)
//   - Agent-tool params `prompt`/`subagent_type` (cannot be repaired — steer)
//   - a `task` wrapper string/object, legacy aliases (`title`/`name`/`content`)
//     or a missing `subject`/`description` that can be backfilled from the other.
// `coerceInput` repairs the recoverable cases so safeParse succeeds; the
// unrecoverable cases fall through to `validationErrorSteer`, which returns a
// usage hint appended to the Zod error. Logic mirrors the 2.1.200 binary.

const SUBJECT_ALIASES = ['title', 'name']
const DESCRIPTION_ALIASES = ['content']
const ACTIVE_FORM_ALIASES = ['active_form']
const ALLOWED_KEYS = new Set(['subject', 'description', 'activeForm', 'metadata'])
// Known-but-unwanted keys: stripped from the repaired input and logged as
// `strip_<key>` (vs `strip_other` for truly unknown keys).
const KNOWN_UNWANTED_KEYS = new Set([
  'status',
  'state',
  'priority',
  'prompt',
  'subagent_type',
  'id',
  'type',
  'owner',
  'blocks',
  'blockedBy',
  'addBlocks',
  'addBlockedBy',
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

function hasTasksOrTodos(v: Record<string, unknown>): boolean {
  return 'tasks' in v || 'todos' in v
}

function hasAgentParams(v: Record<string, unknown>): boolean {
  return 'prompt' in v || 'subagent_type' in v
}

/**
 * Truncate a description down to a usable subject: collapse whitespace, take
 * the first 80 chars, then cut at the last word boundary if it lands past
 * char 40 (so we don't break mid-word). Mirrors the binary's RNf.
 */
function truncateForSubject(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim()
  const chars = Array.from(collapsed)
  if (chars.length <= 80) return collapsed
  const prefix = chars.slice(0, 80).join('')
  const lastSpace = prefix.lastIndexOf(' ')
  return (lastSpace > 40 ? prefix.slice(0, lastSpace) : prefix).trim()
}

/**
 * Repair a malformed TaskCreate input. Returns `{ input, shapeClass }` where
 * `shapeClass` is a `+`-joined log of the repairs applied, or null when no
 * repair was possible / nothing changed (let validation proceed).
 */
function coerceTaskCreateInput(
  raw: unknown,
): { input: Record<string, unknown>; shapeClass: string } | null {
  if (!isPlainObject(raw)) return null
  // TodoWrite-style array param — can't be mapped to a single task.
  if (hasTasksOrTodos(raw)) return null
  const repairs: string[] = []
  const n: Record<string, unknown> = { ...raw }
  // Agent-tool params without valid subject/description — can't be repaired.
  if (hasAgentParams(n) && !(isNonEmptyString(n.subject) && isNonEmptyString(n.description))) {
    return null
  }
  // Unwrap a `task` wrapper (string -> description; object -> merge fields).
  if (!('subject' in n) && !('description' in n) && 'task' in n) {
    const task = n.task
    if (isNonEmptyString(task)) {
      delete n.task
      n.description = task
      repairs.push('task_wrapper_string')
    } else if (isPlainObject(task)) {
      if (hasTasksOrTodos(task)) return null
      if (hasAgentParams(task) && !(isNonEmptyString(task.subject) && isNonEmptyString(task.description))) {
        return null
      }
      delete n.task
      Object.assign(n, task)
      repairs.push('task_wrapper_object')
    } else {
      return null
    }
  }
  // Map legacy aliases onto their canonical fields.
  const aliasMap: Array<[string[], string]> = [
    [SUBJECT_ALIASES, 'subject'],
    [DESCRIPTION_ALIASES, 'description'],
    [ACTIVE_FORM_ALIASES, 'activeForm'],
  ]
  for (const [aliases, canonical] of aliasMap) {
    for (const alias of aliases) {
      if (alias in n && !(canonical in n) && isNonEmptyString(n[alias])) {
        n[canonical] = n[alias]
        delete n[alias]
        repairs.push(`alias_${alias}`)
      }
    }
  }
  // Backfill the missing member of {subject, description} from the other.
  if (isNonEmptyString(n.subject) && !('description' in n)) {
    n.description = n.subject
    repairs.push('backfill_description')
  } else if (isNonEmptyString(n.description) && !('subject' in n)) {
    n.subject = truncateForSubject(n.description as string)
    repairs.push('backfill_subject')
  }
  // H13 (input-repair): if both required fields are still missing after
  // alias-mapping and cross-backfill (e.g. an empty payload or one carrying
  // only metadata), default-fill so the call succeeds instead of surfacing an
  // InputValidationError. `subject` defaults to "Untitled task"; `description`
  // defaults to "" (a valid z.string()). Mirrors the binary's last-resort
  // default for an otherwise-empty task payload.
  if (!isNonEmptyString(n.subject) && !isNonEmptyString(n.description)) {
    n.subject = 'Untitled task'
    n.description = ''
    repairs.push('default_subject', 'default_description')
  }
  // If we now have both required fields (possibly default-filled, where
  // description may be ""), strip unwanted keys + drop invalid optional
  // fields so the repaired object passes strictObject. Use a string check
  // (not isNonEmptyString) so the empty-string default still triggers strip.
  if (typeof n.subject === 'string' && typeof n.description === 'string') {
    for (const key of Object.keys(n)) {
      if (!ALLOWED_KEYS.has(key)) {
        delete n[key]
        repairs.push(`strip_${KNOWN_UNWANTED_KEYS.has(key) ? key : 'other'}`)
      }
    }
    if ('activeForm' in n && typeof n.activeForm !== 'string') {
      delete n.activeForm
      repairs.push('drop_invalid_activeForm')
    }
    if ('metadata' in n && !isPlainObject(n.metadata)) {
      delete n.metadata
      repairs.push('drop_invalid_metadata')
    }
  }
  if (repairs.length === 0) return null
  return { input: n, shapeClass: repairs.join('+') }
}

/**
 * Steering message appended to the InputValidationError when the input matches
 * a known unrecoverable misuse (TodoWrite-style `tasks`/`todos` array, Agent
 * `prompt`/`subagent_type`). For any other malformed plain-object input that
 * coerceInput could not repair (e.g. a type mismatch), returns a concise
 * inputSchema reminder so the model can self-correct on retry. Returns null
 * only when the input is not a plain object.
 */
function taskCreateValidationErrorSteer(raw: unknown): string | null {
  if (!isPlainObject(raw)) return null
  const task = isPlainObject(raw.task) ? raw.task : null
  if (hasTasksOrTodos(raw) || (task !== null && hasTasksOrTodos(task))) {
    return 'TaskCreate creates ONE task per call and has no `tasks` or `todos` parameter. Call TaskCreate once per task, passing `subject` (a brief title) and `description` (what needs to be done) as top-level string parameters.'
  }
  if (
    (hasAgentParams(raw) || (task !== null && hasAgentParams(task))) &&
    !(isNonEmptyString(raw.subject) && isNonEmptyString(raw.description))
  ) {
    return 'This call used Agent-tool parameters (`prompt`/`subagent_type`). TaskCreate adds an item to the task list and takes `subject` and `description` string parameters. To delegate work to a subagent, use the Agent tool instead.'
  }
  // H13 (input-repair): for any other malformed plain-object input that
  // coerceInput could not repair (e.g. a type mismatch on subject/description),
  // surface the expected inputSchema so the model can self-correct on retry
  // instead of only seeing the generic Zod type error.
  return 'TaskCreate inputSchema — `subject` (string, required): a brief title; `description` (string, required): what needs to be done; `activeForm` (string, optional): present-continuous spinner label; `metadata` (object, optional): arbitrary metadata. Pass these as top-level parameters and call TaskCreate once per task.'
}

export const TaskCreateTool = buildTool({
  name: TASK_CREATE_TOOL_NAME,
  searchHint: 'create a task in the task list',
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
    return 'TaskCreate'
  },
  shouldDefer: true,
  isEnabled() {
    return isTodoV2Enabled()
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.subject
  },
  coerceInput(input) {
    return coerceTaskCreateInput(input)
  },
  validationErrorSteer(input) {
    return taskCreateValidationErrorSteer(input)
  },
  renderToolUseMessage() {
    return null
  },
  async call({ subject, description, activeForm, metadata }, context) {
    const taskId = await createTask(getTaskListId(), {
      subject,
      description,
      activeForm,
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata,
    })

    const blockingErrors: string[] = []
    const generator = executeTaskCreatedHooks(
      taskId,
      subject,
      description,
      getAgentName(),
      getTeamName(),
      undefined,
      context?.abortController?.signal,
      undefined,
      context,
    )
    for await (const result of generator) {
      if (result.blockingError) {
        blockingErrors.push(getTaskCreatedHookMessage(result.blockingError))
      }
    }

    if (blockingErrors.length > 0) {
      await deleteTask(getTaskListId(), taskId)
      throw new Error(blockingErrors.join('\n'))
    }

    // Auto-expand task list when creating tasks
    context.setAppState(prev => {
      if (prev.expandedView === 'tasks') return prev
      return { ...prev, expandedView: 'tasks' as const }
    })

    return {
      data: {
        task: {
          id: taskId,
          subject,
        },
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { task } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Task #${task.id} created successfully: ${task.subject}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
