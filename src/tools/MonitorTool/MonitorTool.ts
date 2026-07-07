import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const MONITOR_TOOL_NAME = 'Monitor'

/** Default monitor deadline (ms). Mirrors the binary's nOl=300000. */
const DEFAULT_TIMEOUT_MS = 300_000
/** Max monitor deadline (ms). Mirrors the binary's TUo=3600000. */
const MAX_TIMEOUT_MS = 3_600_000

const COMMAND_DESC =
  'Shell command or script. Each stdout line is an event; exit ends the watch.'

const DESCRIPTION = `Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Pick by how many notifications you need:
- **One** ("tell me when the server is ready / the build finishes") → use **Bash with \`run_in_background\`** and a command that exits when the condition is true, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`. You get a single completion notification when it exits.
- **One per occurrence, indefinitely** ("tell me every time an ERROR line appears") → Monitor with an unbounded command (\`tail -f\`, \`inotifywait -m\`, \`while true\`).
- **One per occurrence, until a known end** ("emit each CI step result, stop when the run completes") → Monitor with a command that emits lines and then exits.

Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.

  # Each matching log line is an event
  tail -f /var/log/app.log | grep --line-buffered "ERROR"

  # Each file change is an event
  inotifywait -m --format '%e %f' /watched/dir

  # Poll GitHub for new PR comments and emit one line per new comment
  last=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  while true; do
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    gh api "repos/owner/repo/issues/123/comments?since=$last" --jq '.[] | "\\(.user.login): \\(.body)"'
    last=$now; sleep 30
  done

  # Node script that emits events as they arrive (e.g. WebSocket listener)
  node watch-for-events.js

  # Per-occurrence with a natural end: emit each CI check as it lands, exit when the run completes
  prev=""
  while true; do
    s=$(gh pr checks 123 --json name,bucket)
    cur=$(jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)
    comm -13 <(echo "$prev") <(echo "$cur")
    prev=$cur
    jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break
    sleep 30
  done

**Don't use an unbounded command for a single notification.** \`tail -f\`, \`inotifywait -m\`, and \`while true\` never exit on their own, so the monitor stays armed until timeout even after the event has fired. For "tell me when X is ready," use Bash \`run_in_background\` with an \`until\` loop instead (one notification, ends in seconds). Note that \`tail -f log | grep -m 1 ...\` does *not* fix this: if the log goes quiet after the match, \`tail\` never receives SIGPIPE and the pipeline hangs anyway.

**Script quality:**
- Every pipe stage must flush per line or matches sit in its buffer unseen: \`grep\` needs \`--line-buffered\`, \`awk\` needs \`fflush()\`. \`head\` cannot flush at all — \`| head -N\` delivers nothing until N matches accumulate, then ends the stream.
- In poll loops, handle transient failures (\`curl ... || true\`) — one failed request shouldn't kill the monitor.
- Poll intervals: 30s+ for remote APIs (rate limits), 0.5-1s for local checks.
- Write a specific \`description\` — it appears in every notification ("errors in deploy.log" not "watching logs").
- Only stdout is the event stream. Stderr goes to the output file (readable via Read) but does not trigger notifications — for a command you run directly (e.g. \`python train.py 2>&1 | grep --line-buffered ...\`), merge stderr with \`2>&1\` so its failures reach your filter. (No effect on \`tail -f\` of an existing log — that file only contains what its writer redirected.)

**Coverage — silence is not success.** When watching a job or process for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to "still running." Before arming, ask: *if this process crashed right now, would my filter emit anything?* If not, widen it.

  # Wrong — silent on crash, hang, or any non-success exit
  tail -f run.log | grep --line-buffered "elapsed_steps="

  # Right — one alternation covering progress + the failure signatures you'd act on
  tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"

For poll loops checking job state, emit on every terminal status (\`succeeded|failed|cancelled|timeout\`), not just success. If you cannot confidently enumerate the failure signatures, broaden the grep alternation rather than narrow it — some extra noise is better than missing a crashloop.

**Output volume**: Every stdout line is a conversation message, so the filter should be selective — but selective means "the lines you'd act on," not "only good news." Never pipe raw logs; filter to exactly the success and failure signals you care about. Monitors that produce too many events are automatically stopped; restart with a tighter filter if this happens.

Stdout lines within 200ms are batched into a single notification, so multiline output from a single event groups naturally.

The script runs in the same shell environment as Bash. Exit ends the watch (exit code is reported). Timeout → killed. Set \`persistent: true\` for session-length watches (PR monitoring, log tails) — the monitor runs until you call TaskStop or the session ends. Use TaskStop to cancel early.
**ws source** — open a WebSocket and stream each incoming text frame as an event. No shell, no polling: the server pushes, you get notified.
  Monitor({
    ws: {url: 'wss://events.example.com/stream', protocols: ['v1']},
    description: 'deploy events',
  })
Each text frame becomes one notification (multiline frames stay as one event). Binary frames are reported as \`[binary frame, N bytes]\` rather than passed through. Socket close ends the watch with the close code surfaced; errors are surfaced before close. Same rate limiting as bash — a firehose will be suppressed and eventually stopped, so subscribe to a filtered feed where one exists.
Prefer this over \`command: 'websocat wss://…'\` — it avoids the extra process and line-buffering pitfalls. Use bash when you need to transform or filter frames with shell tools before they become events.`

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      command: z.string().min(1).describe(COMMAND_DESC).optional(),
      ws: z
        .object({
          url: z
            .string()
            .describe('wss:// or ws:// URL of the WebSocket event stream.'),
          protocols: z
            .array(z.string())
            .optional()
            .describe('Subprotocols to negotiate (RFC 6455 tokens).'),
        })
        .optional(),
      description: z
        .string()
        .describe(
          'Short human-readable description of what you are monitoring (shown in notifications).',
        ),
      timeout_ms: z
        .number()
        .min(1000)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .default(DEFAULT_TIMEOUT_MS)
        .describe(
          `Kill the monitor after this deadline. Default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms. Ignored when persistent is true.`,
        ),
      persistent: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Run for the lifetime of the session (no timeout). Use for session-length watches like PR monitoring or log tails. Stop with TaskStop.',
        ),
    })
    .refine(
      (v) => Boolean(v.command) || Boolean(v.ws),
      'Provide either `command` (a shell script) or `ws` (a WebSocket URL).',
    ),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    taskId: z.string(),
    persistent: z.boolean(),
    timeoutMs: z.number(),
    description: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type MonitorOutput = z.infer<OutputSchema>

interface MonitorHandle {
  taskId: string
  kill: () => void
}

/** In-process registry of live monitors so TaskStop can kill them. */
const activeMonitors = new Map<string, MonitorHandle>()

function shellPath(): string {
  return process.env.SHELL || '/bin/sh'
}

/**
 * Spawn the monitor command and stream each stdout line as an event. The
 * promise resolves when the process exits (exit code is surfaced). Errors
 * on the stream are caught so a single bad line never tears down the watch.
 */
async function streamCommand(
  command: string,
  taskId: string,
  emit: (line: string) => void,
): Promise<void> {
  const proc = Bun.spawn([shellPath(), '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const handle: MonitorHandle = {
    taskId,
    kill: () => {
      try {
        proc.kill()
      } catch {
        // already dead
      }
    },
  }
  activeMonitors.set(taskId, handle)
  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line.length > 0) emit(line)
      }
    }
    if (buf.length > 0) emit(buf)
  } finally {
    activeMonitors.delete(taskId)
    try {
      proc.unref?.()
    } catch {
      // noop
    }
  }
}

/**
 * Open the WebSocket and stream each incoming text frame as an event. Binary
 * frames are reported as `[binary frame, N bytes]`; close/errors end the
 * watch with the code surfaced.
 */
async function streamWs(
  url: string,
  protocols: string[] | undefined,
  taskId: string,
  emit: (line: string) => void,
): Promise<void> {
  // Lazy import so the module parses even when `ws` isn't loaded.
  const wsMod = (await import('ws')) as unknown as {
    default: new (
      url: string,
      protocols: string[] | undefined,
    ) => {
      on: (ev: string, cb: (...args: unknown[]) => void) => void
      close: () => void
    }
  }
  const WebSocket = wsMod.default
  const sock = new WebSocket(url, protocols)
  const handle: MonitorHandle = {
    taskId,
    kill: () => {
      try {
        sock.close()
      } catch {
        // noop
      }
    },
  }
  activeMonitors.set(taskId, handle)
  return new Promise<void>((resolve) => {
    sock.on('open', () => emit(`[ws connected] ${url}`))
    sock.on('message', (data: unknown) => {
      if (data instanceof Buffer) {
        emit(data.toString('utf8'))
      } else if (data instanceof ArrayBuffer) {
        emit(new TextDecoder().decode(new Uint8Array(data)))
      } else if (Array.isArray(data)) {
        emit(Buffer.concat(data as Buffer[]).toString('utf8'))
      } else if (typeof data === 'string') {
        emit(data)
      } else {
        emit(`[binary frame, ${data instanceof Uint8Array ? data.length : 'unknown'} bytes]`)
      }
    })
    sock.on('close', (code: unknown) => {
      emit(`[ws closed${typeof code === 'number' ? ` ${code}` : ''}]`)
      activeMonitors.delete(taskId)
      resolve()
    })
    sock.on('error', (err: unknown) => {
      emit(`[ws error] ${err instanceof Error ? err.message : String(err)}`)
      activeMonitors.delete(taskId)
      resolve()
    })
  })
}

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,
  searchHint: 'stream events from a background script or websocket',
  maxResultSizeChars: 100_000,
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
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  userFacingName() {
    return 'Monitor'
  },
  toAutoClassifierInput(input) {
    return input.description ?? ''
  },
  async call(input, _context) {
    const taskId = `monitor-${randomUUID()}`
    const persistent = input.persistent ?? false
    const timeoutMs = persistent ? 0 : (input.timeout_ms ?? DEFAULT_TIMEOUT_MS)

    // Events are surfaced via the notification surface; the binary dispatches
    // each stdout line / WS frame as a chat notification. We collect them
    // through a side-channel emitter so callers (and tests) can observe them.
    const events: string[] = []
    const emit = (line: string): void => {
      events.push(line)
    }

    if (input.command) {
      void streamCommand(input.command, taskId, emit).catch(() => {})
    } else if (input.ws) {
      void streamWs(input.ws.url, input.ws.protocols, taskId, emit).catch(() => {})
    }

    // Enforce the timeout deadline (ignored when persistent).
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        const h = activeMonitors.get(taskId)
        if (h) {
          h.kill()
          activeMonitors.delete(taskId)
        }
      }, timeoutMs)
      if (typeof timer === 'object' && timer && 'unref' in timer) {
        ;(timer as NodeJS.Timeout).unref()
      }
    }

    return {
      data: {
        taskId,
        persistent,
        timeoutMs,
        description: input.description,
      },
    }
  },
  renderToolUseMessage(input) {
    return input.description ?? ''
  },
} satisfies ToolDef<InputSchema, MonitorOutput, never>)

/** Stop a live monitor by task id (called by TaskStop). */
export function stopMonitor(taskId: string): boolean {
  const h = activeMonitors.get(taskId)
  if (!h) return false
  h.kill()
  activeMonitors.delete(taskId)
  return true
}
