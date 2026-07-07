import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { TerminalNotification } from '../../ink/useTerminalNotification.js'

export const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'

const DESCRIPTION =
  'Send a notification to the user via their terminal and, when Remote Control is connected, also push to their mobile device'

/**
 * Mirrors the binary's wBf input schema: a non-empty body plus a fixed
 * `status: "proactive"` literal (the tool is only invoked for proactive
 * notifications — replies use a normal assistant message instead).
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    message: z
      .string()
      .min(1)
      .describe(
        'The notification body. Keep it under 200 characters; mobile OSes truncate.',
      ),
    status: z.literal('proactive'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * Mirrors the binary's CBf output schema. `disabledReason` explains why a
 * notification was not sent so the model can react (e.g. retry differently).
 */
const outputSchema = lazySchema(() =>
  z.object({
    message: z.string(),
    pushSent: z.boolean().optional(),
    localSent: z.boolean().optional(),
    disabledReason: z
      .enum(['config_off', 'user_present', 'no_transport'])
      .optional(),
    sentAt: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of when the notification was dispatched.'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type PushNotificationOutput = z.infer<OutputSchema>

/**
 * A no-op terminal surface. `sendNotification` records hooks + dispatches to
 * the configured channel (iterm2/kitty/bell/OS binary); the terminal-specific
 * methods are only needed when the channel is a terminal escape sequence. In
 * a tool-call context there may be no live TTY, so no-op is the safe default
 * — the OS notifier path (osascript/notify-send) still fires.
 */
const noopTerminal: TerminalNotification = {
  notifyITerm2: () => {},
  notifyKitty: () => {},
  notifyGhostty: () => {},
  notifyBell: () => {},
  progress: () => {},
}

function isPushDisabled(): boolean {
  // Mirrors the binary's tengu_kairos_push_notifications gate. When the
  // feature is off (the default in this build), surface `config_off` so the
  // model learns the channel is unavailable rather than silently no-op'ing.
  try {
    return process.env.CLAUDE_DISABLE_PUSH_NOTIFICATIONS === '1'
  } catch {
    return true
  }
}

export const PushNotificationTool = buildTool({
  name: PUSH_NOTIFICATION_TOOL_NAME,
  searchHint: 'send a proactive desktop or mobile notification',
  maxResultSizeChars: 1000,
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
    return 'PushNotification'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.message
  },
  async call(input) {
    const message = input.message

    if (isPushDisabled()) {
      return {
        data: {
          message,
          disabledReason: 'config_off' as const,
        },
      }
    }

    let localSent = false
    let disabledReason: 'user_present' | 'no_transport' | undefined
    try {
      // Lazy import keeps the module parse-safe if the notifier pulls in
      // heavy deps; in practice it loads fine but lazy is the safe pattern.
      const { sendNotification } = await import(
        '../../services/notifier.js'
      )
      await sendNotification(
        {
          message,
          notificationType: 'proactive',
          title: 'Claude Code',
        },
        noopTerminal,
      )
      localSent = true
    } catch {
      disabledReason = 'no_transport'
    }

    return {
      data: {
        message,
        localSent,
        disabledReason,
        sentAt: localSent ? new Date().toISOString() : undefined,
      },
    }
  },
  renderToolUseMessage() {
    return null
  },
} satisfies ToolDef<InputSchema, PushNotificationOutput, never>)
