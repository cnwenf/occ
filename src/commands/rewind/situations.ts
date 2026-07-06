/**
 * claude-code 2.1.191: /rewind can resume from BEFORE a /clear.
 *
 * When a user runs /clear, the pre-clear conversation is preserved on disk as
 * a previous session (clearConversation calls regenerateSessionId, leaving the
 * old session file behind). /rewind's message selector shows it as the
 * "previous-session entry at the top", letting the user restore the pre-/clear
 * conversation.
 *
 * This situation descriptor (id / situation / feature / action) is the exact
 * wording the 2.1.200 binary uses for the proactive/spoken suggestion that
 * surfaces /rewind-past-clear. Grep-verified against the official binary.
 */
export type RewindSituation = {
  id: string
  situation: string
  feature: string
  action: string
}

export const rewindPastClearSituation: RewindSituation = {
  id: 'rewind-past-clear',
  situation:
    'User ran /clear earlier this session and now wants something from before it — "I shouldn\'t have cleared", "before I cleared we had X", "I lost that when I cleared", or asks Claude to recall work from before /clear. Also matches asking to undo a /clear or get back to the pre-clear state. IMPORTANT: Do NOT match regret about file edits (that is undo-changes), or wanting context from a previous session (that is previous-session-reference).',
  feature:
    '/rewind can take you back to before /clear — pick the previous-session entry to restore the pre-/clear conversation.',
  action:
    'Press Esc twice or type /rewind, then pick the previous-session entry at the top',
}
