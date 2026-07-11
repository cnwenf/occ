import type { AgentId } from '../types/ids.js'
import {
  getCommandsByMaxPriority,
  isSlashCommand,
} from './messageQueueManager.js'
import type { QueuedCommand } from '../types/textInputTypes.js'

export type QueuedCommandDrainOptions = {
  sleepRan: boolean
  isMainThread: boolean
  currentAgentId: AgentId | undefined
  maxTurns: number | undefined
  turnCount: number
}

/**
 * Build the queued-command drain snapshot for the current query iteration.
 *
 * Returns the commands to drain as attachments (sent to the model on the
 * next turn). Excludes slash commands (those go through processSlashCommand
 * after the turn) and, for subagents, restricts to this agent's
 * task-notifications (user prompts never reach a subagent even if an
 * agentId is stamped on one).
 *
 * 2.1.205 #3: when this turn is about to end at --max-turns, returns [] so
 * queued prompt messages stay in the queue for the next query. Previously
 * the drain consumed them (removed from the queue) and turned them into
 * tool attachments, but the max_turns return meant the model never saw
 * them — the user's mid-turn message was lost.
 */
export function getQueuedCommandDrainSnapshot(
  opts: QueuedCommandDrainOptions,
): QueuedCommand[] {
  if (opts.maxTurns && opts.turnCount + 1 > opts.maxTurns) {
    return []
  }
  return getCommandsByMaxPriority(opts.sleepRan ? 'later' : 'next').filter(
    cmd => {
      if (isSlashCommand(cmd)) return false
      if (opts.isMainThread) return cmd.agentId === undefined
      return (
        cmd.mode === 'task-notification' &&
        cmd.agentId === opts.currentAgentId
      )
    },
  )
}
