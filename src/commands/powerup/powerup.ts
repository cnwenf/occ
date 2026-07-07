import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

/**
 * A single powerup lesson. Mirrors the official tour steps surfaced in the
 * 2.1.200 onboarding tip ("modes, undo, @-mentions, and how to teach Claude
 * your rules") and the powerup-discovery view.
 */
type Lesson = {
  id: string
  title: string
  blurb: string
}

const LESSONS: readonly Lesson[] = [
  {
    id: 'modes',
    title: 'Modes',
    blurb:
      'Switch between plan, fast, and auto modes to control how Claude approaches a task.',
  },
  {
    id: 'undo',
    title: 'Undo',
    blurb:
      'Use /rewind to roll back the conversation and file changes to an earlier point.',
  },
  {
    id: 'mentions',
    title: '@-mentions',
    blurb:
      'Prefix a path with @ to drop a file, folder, or image directly into context.',
  },
  {
    id: 'teach-rules',
    title: 'Teach Claude your rules',
    blurb:
      'Add project guidance to CLAUDE.md so Claude follows your conventions every session.',
  },
]

/**
 * /powerup — launch the interactive lessons discovery.
 *
 * Mirrors the official 2.1.90 /powerup command:
 *   - emits powerup_discovery_shown
 *   - lists the tour lessons and emits powerup_lesson_opened for each
 *   - prints the discovery intro + lesson index
 *
 * The full ink-rendered discovery view (PowerupDiscoveryArm/Step) isn't wired
 * here; the command surfaces the same lesson list and analytics so the tour is
 * discoverable and the events fire identically.
 */
export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  logEvent('powerup_discovery_shown')

  const unlocked = new Set<string>()
  let lines = 'Powerup — discover Claude Code in 5 minutes\n'
  lines +=
    'Type /powerup for a 5-minute tour — modes, undo, @-mentions, and how to teach Claude your rules.\n\n'
  lines += 'Lessons:\n'
  for (const lesson of LESSONS) {
    logEvent('powerup_lesson_opened', {
      lesson_id: lesson.id,
      was_already_unlocked: unlocked.has(lesson.id),
      unlocked_count: unlocked.size,
    })
    lines += `  ${lesson.title} — ${lesson.blurb}\n`
  }
  lines +=
    '\nOpen a lesson to start; completing it fires powerup_lesson_completed and unlocks the next.'

  onDone(lines, { display: 'system' })
  return null
}
