import { Box, Text } from '../ink.js'
import type { RemoteChannel } from '../daemon/remoteControlServer.js'

interface SlackChannelHeaderProps {
  /** Active Slack channel binding, or null when none is connected. */
  channel: RemoteChannel | null
}

/**
 * I14 — renders a `#channel-name` header when the REPL is bound to a Slack
 * channel via Remote Control (B7). Returns null when no channel is connected
 * (no regression for standalone sessions). Persistent while connected.
 *
 * Mirrors the TeammateViewHeader "Viewing @agent" pattern: a dim prefix
 * followed by the channel name in cyan bold.
 */
export function SlackChannelHeader({ channel }: SlackChannelHeaderProps) {
  if (!channel) return null
  return (
    <Box paddingLeft={2} marginBottom={1}>
      <Text dimColor>Connected to </Text>
      <Text color="ansi:cyan" bold>
        #{channel.name}
      </Text>
    </Box>
  )
}
