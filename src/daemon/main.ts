/**
 * Entry point for `claude daemon` — the supervisor + subcommand dispatcher.
 *
 * Replaces the auto-generated stub. Reachable via:
 *   - the (feature-gated) cli.tsx fast-path `claude daemon [sub]`
 *   - the main.tsx Commander `daemon` command tree (the live path, since
 *     feature('DAEMON') is false in this build)
 *
 * `daemon start` (and bare `daemon`) runs the supervisor in-process.
 * All other subcommands are delegated to the CLI handler.
 */

import { runSupervisor } from './supervisor.js'

export const daemonMain: (args: string[]) => Promise<void> = async (
  args: string[],
): Promise<void> => {
  const sub = args[0] ?? 'start'

  if (sub === 'start' || sub === undefined) {
    await runSupervisor(args.length > 0 ? args.slice(1) : ['start'])
    return
  }

  // Delegate everything else to the CLI handler (install/status/stop/logs/...).
  const { daemonSubcommand } = await import('../cli/handlers/daemon.js')
  await daemonSubcommand(sub, args.slice(1))
}

export { runSupervisor } from './supervisor.js'
