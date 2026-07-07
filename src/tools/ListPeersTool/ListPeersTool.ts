import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * The binary renamed ListPeers → ListAgents (x9e="ListAgents"); ListPeers is
 * kept as an alias so older transcripts/tool_use blocks still resolve.
 */
export const LIST_AGENTS_TOOL_NAME = 'ListAgents'

const DESCRIPTION = `Lists agents you can SendMessage to — in-process subagents you spawned, other local Claude sessions on this machine, your Claude sessions running in the cloud (when this session has cloud access), and (when Remote Control is connected) remote bridge sessions, which you can only reply to. Names are the address: send with \`SendMessage({to: "<name>", message: "..."})\`, copying the name exactly as a row prints it. Append a row's \` [ref]\` only when the bare name is not enough — two rows share it, or an error asks you to disambiguate.`

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const AgentTypeSchema = z.enum([
  'in_process',
  'local',
  'cloud',
  'remote_bridge',
])

const outputSchema = lazySchema(() =>
  z.object({
    agents: z.array(
      z.object({
        name: z.string().describe('Display name — the SendMessage `to` address.'),
        type: AgentTypeSchema,
        ref: z
          .string()
          .optional()
          .describe(
            'Disambiguator shown as ` [ref]` when two rows share a bare name.',
          ),
        status: z.string().optional(),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ListAgentsOutput = z.infer<OutputSchema>

/** ~/.claude/sessions/ — the PID registry shared with `claude ps`. */
function getSessionsDir(): string {
  return join(homedir(), '.claude', 'sessions')
}

interface SessionFile {
  pid?: number
  sessionId?: string
  name?: string
  kind?: string
  bridgeId?: string
}

/**
 * Read every *.json PID file in the sessions dir, skip the current process,
 * and surface the live ones as `local` peers. Best-effort: a stale/unreadable
 * file is dropped rather than crashing the tool.
 */
async function listLocalSessions(): Promise<
  Array<{ name: string; type: 'local'; ref?: string; status?: string }>
> {
  const dir = getSessionsDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: Array<{
    name: string
    type: 'local'
    ref?: string
    status?: string
  }> = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const file = join(dir, entry)
    try {
      const raw = (await readFile(file, 'utf8')) as string
      const data = JSON.parse(raw) as SessionFile
      if (typeof data.pid === 'number' && data.pid === process.pid) continue
      const name =
        data.name ||
        (typeof data.sessionId === 'string'
          ? data.sessionId.slice(0, 8)
          : `session-${data.pid ?? entry}`)
      out.push({
        name,
        type: 'local',
        ref: typeof data.sessionId === 'string' ? data.sessionId : undefined,
        status: data.kind,
      })
    } catch {
      // stale/unreadable PID file — skip
    }
  }
  return out
}

/**
 * Cloud and remote-bridge peers require a connected transport this build
 * doesn't wire (cloud sync + Remote Control bridge). The hooks are here so
 * the call() is honest about where each category would come from.
 */
async function listCloudSessions(): Promise<
  Array<{ name: string; type: 'cloud'; ref?: string; status?: string }>
> {
  return []
}

async function listRemoteBridgeSessions(): Promise<
  Array<{
    name: string
    type: 'remote_bridge'
    ref?: string
    status?: string
  }>
> {
  return []
}

export const ListPeersTool = buildTool({
  name: LIST_AGENTS_TOOL_NAME,
  aliases: ['ListPeers'],
  searchHint: 'list peer agents and local sessions to message',
  maxResultSizeChars: 50_000,
  shouldDefer: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'ListAgents'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput() {
    return ''
  },
  async call(_input, context) {
    // In-process subagents: background agent tasks registered in AppState.
    // Each spawned agent/teammate is tracked as a task; surface live ones.
    const inProcess: Array<{
      name: string
      type: 'in_process'
      ref?: string
      status?: string
    }> = []
    try {
      const appState = context?.getAppState?.()
      const tasks = (appState as unknown as { tasks?: unknown[] } | null)
        ?.tasks
      if (Array.isArray(tasks)) {
        for (const t of tasks) {
          const task = t as {
            type?: string
            taskId?: string
            description?: string
            agentId?: string
            status?: string
            name?: string
          }
          if (
            task &&
            (task.type === 'local_agent' ||
              task.type === 'in_process_teammate' ||
              task.type === 'local_workflow')
          ) {
            inProcess.push({
              name:
                task.name ||
                task.description ||
                task.taskId ||
                task.agentId ||
                'agent',
              type: 'in_process',
              ref: task.taskId ?? task.agentId,
              status: task.status,
            })
          }
        }
      }
    } catch {
      // AppState shape varies; in-process list is best-effort.
    }

    const [local, cloud, remote] = await Promise.all([
      listLocalSessions(),
      listCloudSessions(),
      listRemoteBridgeSessions(),
    ])

    const agents = [...inProcess, ...local, ...cloud, ...remote]
    return { data: { agents } }
  },
  renderToolUseMessage() {
    return null
  },
} satisfies ToolDef<InputSchema, ListAgentsOutput, never>)
