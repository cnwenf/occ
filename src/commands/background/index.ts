/**
 * /background command - minimal metadata only.
 * Implementation is lazy-loaded from background.ts to reduce startup time.
 *
 * Mirrors official Claude Code: "Send this session to the background and
 * free the terminal" — backgrounds the current query (not a daemon spawn).
 */
import type { Command } from '../../commands.js'

const background = {
  type: 'local-jsx',
  name: 'background',
  aliases: ['bg'],
  description: 'Send this session to the background and free the terminal',
  argumentHint: '[prompt]',
  // Execute immediately (no Enter needed) when invoked without a prompt.
  // With a prompt argument, the user still submits via Enter so the prompt
  // is captured. Mirrors official `immediate: e => !e.trim()`.
  // `local-jsx` (not `local`) so `immediate` bypasses the query queue during
  // a running turn (REPL.tsx:3293 only honors `immediate` for local-jsx).
  immediate: true,
  isEnabled: () => true,
  load: () => import('./background.js'),
} satisfies Command

export default background
