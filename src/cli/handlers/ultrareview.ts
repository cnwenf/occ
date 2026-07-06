/**
 * `claude ultrareview` subcommand handler.
 *
 * Runs a cloud-hosted multi-agent code review of the current branch (or a
 * PR number / base branch) and prints the findings. Mirrors the official
 * 2.1.200 `ultrareviewHandler` telemetry and error wording.
 *
 * Dynamically imported only when `claude ultrareview` runs.
 */

import { logEvent } from '../../services/analytics/index.js'
import {
  checkRemoteAgentEligibility,
  formatPreconditionError,
} from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'

export type UltrareviewOptions = {
  json?: boolean
  timeout?: string
}

const DEFAULT_TIMEOUT_MINUTES = 30

function fail(message: string): never {
  // eslint-disable-next-line no-console
  console.error(message)
  process.exit(1)
}

export async function ultrareviewHandler(
  target: string,
  options: UltrareviewOptions,
): Promise<void> {
  // Match the binary: SIGINT exits 130
  const onSigInt = () => process.exit(130)
  process.once('SIGINT', onSigInt)

  logEvent('cli_ultrareview', {
    target: target || '',
    json: !!options.json,
  })

  // Resolve timeout (minutes). Default 30.
  const timeoutMinutes =
    Number.isFinite(Number(options.timeout)) && Number(options.timeout) > 0
      ? Number(options.timeout)
      : DEFAULT_TIMEOUT_MINUTES

  // Eligibility / precondition check (auth, git repo, GitHub remote, app
  // install, policy). no_remote_environment is not a blocker — the synthetic
  // code-review env id works without per-org setup, matching launchRemoteReview.
  const eligibility = await checkRemoteAgentEligibility({ skipBundle: true })
  if (!eligibility.eligible) {
    const blockers = eligibility.errors.filter(
      e => e.type !== 'no_remote_environment',
    )
    if (blockers.length > 0) {
      const reasons = blockers.map(formatPreconditionError).join('\n')
      logEvent('cli_ultrareview', { stage: 'cli_ultrareview_launch_failed' })
      fail(`Ultrareview could not launch:\n${reasons}`)
    }
  }

  // Attempt the cloud launch. The full launch path (RemoteAgentTask
  // registration + cloud container + polling) requires the REPL/ToolUseContext
  // and live cloud endpoints. In the CLI we attempt the preflight; if the
  // cloud session cannot be stood up, surface the binary's launch-failed
  // wording rather than a raw stack trace.
  try {
    const { launchRemoteReview } = await import(
      '../../commands/review/reviewRemote.js'
    )
    // launchRemoteReview expects a ToolUseContext; the CLI does not have one,
    // so we call into the shared eligibility+preflight path indirectly. If the
    // import or call throws, we surface the launch-failed message.
    const result = await launchRemoteReview(
      target,
      // Minimal context stub — the CLI launch only needs the launch decision,
      // not full tool rendering. reviewRemote tolerates a partial context for
      // the precondition phase; deep cloud calls will throw, caught below.
      // @ts-expect-error CLI context is intentionally partial
      {},
      '',
    )
    if (result === null) {
      // Caller would fall through to local review; in CLI mode there is no
      // local review, so treat as a launch failure.
      logEvent('cli_ultrareview', { stage: 'cli_ultrareview_launch_failed' })
      fail(
        'Ultrareview could not launch: no cloud review session was started. Run from a git branch with changes and try again.',
      )
    }
    const text = result
      .map(block => ('text' in block ? block.text : ''))
      .join('\n')
      .trim()
    if (text.startsWith('Ultrareview cannot launch')) {
      logEvent('cli_ultrareview', { stage: 'cli_ultrareview_launch_failed' })
      fail(text)
    }
    // eslint-disable-next-line no-console
    console.log(text)
    // eslint-disable-next-line no-console
    console.log(
      `(timeout: ${timeoutMinutes} min${options.json ? ' · --json' : ''})`,
    )
    process.exit(0)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logEvent('cli_ultrareview', { stage: 'cli_ultrareview_launch_failed' })
    fail(`Ultrareview could not launch: ${message}`)
  }
}
