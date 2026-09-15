import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { formatDuration } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { pluralize } from '../../utils/oauthLoginExpiry.js'

export const MONITOR_TOOL_NAME = 'Monitor'

/** Default monitor deadline (ms). Mirrors the binary's nOl=300000. */
const DEFAULT_TIMEOUT_MS = 300_000
/** Max monitor deadline (ms). Mirrors the binary's TUo=3600000. */
const MAX_TIMEOUT_MS = 3_600_000
/**
 * Hard deadline cap (ms) applied when arming a monitor — 30 minutes. Mirrors
 * the binary's o=1800000 (2.1.271 flipped gate tengu_breezy_crescent ON, so
 * every watch dies at this cap and `persistent` is a compat-only field).
 */
const MONITOR_DEADLINE_CAP_MS = 1_800_000
/**
 * Deadline cap in single-shot print (-p) sessions — 10 minutes. Mirrors the
 * binary's r=600000.
 */
const MONITOR_DEADLINE_CAP_PRINT_MS = 600_000

/**
 * Effective deadline cap: the print cap in single-shot print (-p) sessions,
 * else the 30-minute cap. Mirrors the binary's VSe() (BAe() =
 * launchOptions.singleShotPrintSession(), which maps to OCC's
 * getIsNonInteractiveSession()).
 */
function monitorDeadlineCap(): number {
  return getIsNonInteractiveSession()
    ? MONITOR_DEADLINE_CAP_PRINT_MS
    : MONITOR_DEADLINE_CAP_MS
}

/** Formats ms as whole minutes ("5 minutes"). Mirrors the binary's PMt. */
function formatMonitorMinutes(ms: number): string {
  return `${Math.round(ms / 60000)} minutes`
}

/** Normalized arming params. Mirrors the binary's _kr gate-ON return shape. */
export interface NormalizedMonitorInput {
  readonly timeoutMs: number
  readonly persistent: false
}

/**
 * 2.1.271+ gate-ON normalization (binary _kr): `persistent` is forced false
 * and the deadline is capped at monitorDeadlineCap() (VSe). The schema keeps
 * both fields for compat; this is where the cap actually lands.
 */
export function normalizeMonitorInput(input: {
  timeout_ms?: number
  persistent?: boolean
}): NormalizedMonitorInput {
  return {
    timeoutMs: Math.min(
      input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      monitorDeadlineCap(),
    ),
    persistent: false,
  }
}

/**
 * Expiry notice emitted through the event side-channel when the deadline
 * fires. Mirrors the binary's Crn (Lt = formatDuration with hideTrailingZeros,
 * x = pluralize). `eventCount` is the number of events actually delivered.
 */
export function monitorExpiredNotice(
  timeoutMs: number,
  eventCount: number,
): string {
  const duration = formatDuration(timeoutMs, { hideTrailingZeros: true })
  if (eventCount === 0) {
    return `[Monitor expired after ${duration} with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]`
  }
  return `[Monitor expired after ${duration} with ${eventCount} ${pluralize(eventCount, 'event')} delivered. Re-arm it if you still need the watch.]`
}

const COMMAND_DESC =
  'Shell command or script. Each stdout line is an event; exit ends the watch.'

/**
 * Gate-ON deadline section of the description (2.1.271+). Built dynamically so
 * "at most …" reflects the session-mode cap: 30 minutes interactive, 10
 * minutes in print sessions. Mirrors the binary's PMt(Aqe)/PMt(VSe())
 * composition.
 */
function deadlineSection(): string {
  return `Every monitor expires after \`timeout_ms\` (default ${formatMonitorMinutes(DEFAULT_TIMEOUT_MS)}, at most ${formatMonitorMinutes(monitorDeadlineCap())}): it is killed and you get one notice with the event count. Re-arm it if you still need the watch; for a long watch (PR monitoring, log tails) set \`timeout_ms\` to the maximum and re-arm on each expiry, and widen the filter if an expiry with no events was unexpected.`
}

function buildDescription(): string {
  return `**OCC build note (event delivery not yet wired):** in this build, Monitor events and the expiry notice are recorded internally but are NOT delivered to the chat — the notification consumer is a tracked follow-up (occ127). The deadline itself IS enforced: every monitor is killed and deregistered at \`timeout_ms\`. Until delivery lands, use Bash \`run_in_background\` when you need a delivered completion notification, and read the delivery-dependent statements below ("notifications arrive in the chat", the expiry notice) as describing not-yet-available behavior.

Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

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

The script runs in the same shell environment as Bash. Exit ends the watch (exit code is reported). ${deadlineSection()} Use TaskStop to cancel early.
**ws source** — open a WebSocket and stream each incoming text frame as an event. No shell, no polling: the server pushes, you get notified.
  Monitor({
    ws: {url: 'wss://events.example.com/stream', protocols: ['v1']},
    description: 'deploy events',
  })
Each text frame becomes one notification (multiline frames stay as one event). Binary frames are reported as \`[binary frame, N bytes]\` rather than passed through. Socket close ends the watch with the close code surfaced; errors are surfaced before close. Same rate limiting as bash — a firehose will be suppressed and eventually stopped, so subscribe to a filtered feed where one exists.
Prefer this over \`command: 'websocat wss://…'\` — it avoids the extra process and line-buffering pitfalls. Use bash when you need to transform or filter frames with shell tools before they become events.`
}

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

/** Injectable deps for fireMonitorDeadline (registry override is for tests). */
export interface MonitorDeadlineDeps {
  readonly taskId: string
  readonly timeoutMs: number
  readonly eventCount: number
  readonly emit: (line: string) => void
  readonly registry?: ReadonlyMap<string, MonitorHandle> &
    Pick<Map<string, MonitorHandle>, 'delete'>
}

/**
 * Fire the deadline kill for a monitor, gated on it still being live.
 *
 * Official 2.1.272 (binary call site, verbatim):
 *   let W = setTimeout((u,O,D,C,E,x)=>{ if(u.isKilled())return; if(x.bounded){…}
 *     D1(O,Crn(x.timeoutMs,u.eventCount(),x.bounded),D,{isHousekeeping:!0,agentId:C}),
 *     l2(D,E) }, …)
 *   _.result.then(()=>{ if(W)clearTimeout(W); … })
 *
 * The liveness check comes FIRST: a monitor that exited naturally or was
 * stopped never produces an "expired" notice (official also clears the timer
 * on natural exit; OCC's stream helpers self-deregister from the registry, so
 * the registry lookup carries the same gate). Returns true when the monitor
 * was still live (notice emitted, then killed + deregistered), false when it
 * had already ended (no notice). Exported for testing.
 */
export function fireMonitorDeadline(deps: MonitorDeadlineDeps): boolean {
  const registry = deps.registry ?? activeMonitors
  const h = registry.get(deps.taskId)
  if (!h) return false
  deps.emit(monitorExpiredNotice(deps.timeoutMs, deps.eventCount))
  h.kill()
  registry.delete(deps.taskId)
  return true
}

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
    return buildDescription()
  },
  async prompt() {
    return buildDescription()
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
    // 2.1.271+ (gate tengu_breezy_crescent ON): normalization forces
    // persistent:false and caps the deadline (binary _kr/VSe). The schema
    // field stays for compat.
    const { timeoutMs, persistent } = normalizeMonitorInput(input)

    // OCC divergence (banner in the description): the binary dispatches each
    // stdout line / WS frame as a chat notification (D1). This build has no
    // delivery consumer wired yet, so events are recorded through a
    // closure-local side-channel emitter (observable by tests); the wiring is
    // a tracked follow-up (occ127).
    const events: string[] = []
    const emit = (line: string): void => {
      events.push(line)
    }

    if (input.command) {
      void streamCommand(input.command, taskId, emit).catch(() => {})
    } else if (input.ws) {
      void streamWs(input.ws.url, input.ws.protocols, taskId, emit).catch(() => {})
    }

    // The kill timer is ALWAYS armed (no persistent bypass). On expiry the Crn
    // notice goes out ONLY if the monitor is still live in the registry — the
    // official call site gates on liveness first (`if(u.isKilled())return`),
    // so natural exits / manual stops produce no false "expired" notice.
    // See fireMonitorDeadline for the verbatim binary evidence.
    const timer = setTimeout(() => {
      fireMonitorDeadline({
        taskId,
        timeoutMs,
        eventCount: events.length,
        emit,
      })
    }, timeoutMs)
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      ;(timer as NodeJS.Timeout).unref()
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
