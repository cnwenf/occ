// C14 (2.1.199): stacked slash-skill invocations.
//
// When a user types `/skill-a /skill-b do XYZ`, the leading slash-skill tokens
// are each loaded (up to MAX_STACKED_SKILLS) and "do XYZ" becomes the trailing
// args. Mirrors the official 2.1.200 binary's GFl() split + jFl cap +
// tengu_stacked_slash_commands telemetry. Only prompt skills that are
// user-invocable, non-fork, and don't themselves accept slash-command args are
// stackable (matches the binary's filter: p.type==="prompt" && p.context!=="fork"
// && !p.argsMayContainSlashCommands && p.userInvocable!==false).
import type { Command } from '../commands.js'
import { findCommand } from '../commands.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { parseSlashCommand } from '../utils/slashCommandParsing.js'

/** jFl in the official binary — max leading skills loaded from one input. */
export const MAX_STACKED_SKILLS = 5

export interface StackedSlashCommand {
  command: Command
  args: string
}

export interface StackedSplitResult {
  /** Leading stackable skills, in input order. */
  stacked: StackedSlashCommand[]
  /** Remaining text after the last leading slash-skill (the real task). */
  trailingArgs: string
  /** True when the leading-skill count hit MAX_STACKED_SKILLS. */
  capped: boolean
}

/**
 * Whether a command may participate in a stacked invocation. Mirrors the
 * binary's per-command filter (the QC/b3 checks collapse to isEnabled +
 * userInvocable here).
 */
export function isStackableSkill(command: Command | undefined): boolean {
  if (!command) return false
  if (command.type !== 'prompt') return false
  if (command.context === 'fork') return false
  if (command.argsMayContainSlashCommands) return false
  if (command.userInvocable === false) return false
  if (command.isEnabled && !command.isEnabled()) return false
  return true
}

/**
 * Split an args string into leading stacked slash-skills + trailing args.
 *
 * E.g. `/commit /review-pr fix the bug` with commands=[commit, review-pr] →
 * { stacked: [{commit}, {review-pr}], trailingArgs: "fix the bug", capped: false }.
 *
 * Mirrors GFl(e, t, n, r) from the official binary: walk leading `/name [args]`
 * tokens, resolve each against `commands`, keep only stackable skills, stop at
 * the first non-slash token or the cap.
 */
export function splitStackedSlashCommands(
  args: string,
  commands: Command[],
): StackedSplitResult {
  const stacked: StackedSlashCommand[] = []
  let remaining = args
  let capped = false

  for (let i = 0; i < MAX_STACKED_SKILLS + 1; i++) {
    const trimmed = remaining.trimStart()
    if (!trimmed.startsWith('/')) break
    if (i >= MAX_STACKED_SKILLS) {
      capped = true
      break
    }
    const parsed = parseSlashCommand(trimmed)
    if (!parsed) break
    const command = findCommand(parsed.commandName, commands)
    if (!isStackableSkill(command)) break
    stacked.push({ command, args: parsed.args })
    remaining = parsed.args
  }

  return { stacked, trailingArgs: remaining, capped }
}

/**
 * Telemetry for a stacked invocation. Mirrors the binary's
 * `q("tengu_stacked_slash_commands", { stacked_count: m.length })`.
 */
export function logStackedSlashCommands(count: number): void {
  if (count <= 0) return
  logEvent('tengu_stacked_slash_commands', {
    stacked_count: count as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * Result of loading a single skill — the shape processPromptSlashCommand /
 * getMessagesForPromptSlashCommand return. loadStackedSkills merges these.
 */
export interface LoadedSkillMessages {
  messages: Array<Record<string, unknown>>
  allowedTools?: string[]
}

/**
 * Load each stacked skill (with the shared trailing args) and merge into one
 * message list. Mirrors the binary's stacked-expansion loop: every stacked
 * skill's user messages are tagged `stackedExpansion: true` so transcript
 * replay can distinguish them, and their allowedTools are unioned in. The
 * loader is injected so this module stays free of processSlashCommand imports.
 */
export async function loadStackedSkills(
  stacked: StackedSlashCommand[],
  trailingArgs: string,
  loadSkill: (
    command: Command,
    args: string,
  ) => Promise<LoadedSkillMessages>,
): Promise<LoadedSkillMessages> {
  const messages: Array<Record<string, unknown>> = []
  const allowedTools = new Set<string>()
  for (const { command, args } of stacked) {
    const loaded = await loadSkill(command, args || trailingArgs)
    for (const msg of loaded.messages) {
      // Tag stacked-skill user messages so replay reconstructs the expansion.
      if (msg.type === 'user') msg.stackedExpansion = true
    }
    messages.push(...loaded.messages)
    for (const t of loaded.allowedTools ?? []) allowedTools.add(t)
  }
  return { messages, allowedTools: [...allowedTools] }
}

