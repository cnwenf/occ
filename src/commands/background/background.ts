import type { LocalCommandCall } from '../../types/command.js'
import { spawnWorker } from '../../daemon/workerRegistry.js'
import { getCwd } from '../../utils/cwd.js'

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * /background — spawn a 'default' daemon worker in the current working
 * directory so the current task can continue in the background while the
 * main prompt is freed.
 *
 * The worker is a real `claude --daemon-worker default` child process tracked
 * by the in-memory registry (and persisted to ~/.claude/daemon-status.json).
 * Use /stop <id> to stop it later.
 */
export const call: LocalCommandCall = async () => {
  try {
    const record = spawnWorker('default', { cwd: getCwd() })
    return {
      type: 'text',
      value:
        `Moved to background: worker id=${record.id} pid=${record.pid} ` +
        `kind=${record.kind} cwd=${record.cwd}\n` +
        `The main prompt is free. Run /stop ${record.id} to stop it later.`,
    }
  } catch (err: unknown) {
    return {
      type: 'text',
      value: `Failed to spawn background worker: ${toMessage(err)}`,
    }
  }
}
