import { spawn } from 'child_process'
import { mkdir, open, rm } from 'fs/promises'
import { dirname } from 'path'
import { describe, expect, test } from 'bun:test'
import { generateTaskId } from '../../Task.js'
import { TaskOutput } from '../task/TaskOutput.js'
import { wrapSpawn } from '../ShellCommand.js'

/**
 * CC 2.1.311 #56 (WP-Q) Path B: where the "Command timed out after …" note
 * lands when a foreground (non-auto-backgrounding) command is SIGTERM-killed
 * on timeout.
 *
 * Byte evidence — official linux-x64 ELFs at /tmp/cc-diff-311/{v310,v311}/
 * package/claude (READ-ONLY, never executed; grep -aboF + dd):
 *
 * Official ShellCommand exit-note builder q() @ v311:248737200 (IDENTICAL in
 * v310 @246959519):
 *   let q=(Se)=>{ if(this.taskOutput.stdoutToFile && !this.#t)
 *                   G.stdout = H ? `${Se}\n${H}` : Se        // file mode, NOT backgrounded
 *                 else
 *                   G.stderr = G.stderr ? `${Se} ${G.stderr}` : Se }
 * with branches: killed-for-size → "Command killed: output file exceeded …";
 * timeout (SIGTERM) → "Command timed out after ${an(this.#m)}".
 *
 * So in FILE mode (bash commands, #t = backgrounded flag unset) the timeout
 * note is PREPENDED TO STDOUT — newline-joined ahead of the partial output.
 * BashTool's kill path then throws ShellError('', stdout-with-note) whose
 * getErrorParts surface ([Exit code, interrupted?, stderr, stdout]) delivers
 * both the note AND the partial output to the model.
 *
 * OCC drift being fixed: ShellCommand.#handleExit unconditionally prepends
 * the note to STDERR, which BashTool's kill-path ShellError('', stdout, …)
 * construction discards — the note never reaches the model. The killed-for-
 * size branch already matches official (it only fires while backgrounded,
 * #t=true ⇒ stderr path) and stays unchanged.
 */

const SIGTERM_CODE = 143
const TIMEOUT_MS = 1200

describe('2.1.311 #56 — ShellCommand timeout note placement (official q())', () => {
  test(
    'file mode: note is prepended to stdout, ahead of the partial output',
    async () => {
      // Arrange — real spawn, both fds pointed at the task output file
      // (exactly how BashTool wires file-mode commands).
      const taskId = generateTaskId('local_bash')
      const taskOutput = new TaskOutput(taskId, null, true)
      await rm(taskOutput.path, { force: true })
      await mkdir(dirname(taskOutput.path), { recursive: true })
      const handle = await open(taskOutput.path, 'w')
      const child = spawn('bash', ['-c', "printf 'wpq-partial-311\\n'; sleep 10"], {
        stdio: ['ignore', handle.fd, handle.fd],
      })
      // shouldAutoBackground=false ⇒ #handleTimeout → #doKill(SIGTERM).
      const command = wrapSpawn(child, new AbortController().signal, TIMEOUT_MS, taskOutput, false)
      // Act
      const result = await command.result
      await handle.close()
      command.cleanup()
      // Assert — official q(): stdoutToFile && !backgrounded ⇒ note in STDOUT,
      // newline-joined ahead of the partial output; stderr untouched.
      expect(result.code).toBe(SIGTERM_CODE)
      expect(result.stdout.startsWith('Command timed out after')).toBe(true)
      expect(result.stdout).toContain('wpq-partial-311')
      expect(result.stdout.indexOf('Command timed out after')).toBeLessThan(
        result.stdout.indexOf('wpq-partial-311'),
      )
      expect(result.stderr).not.toContain('Command timed out after')
      await rm(taskOutput.path, { force: true })
    },
    15_000,
  )

  test(
    'pipe mode: note stays in stderr (official q() else-branch) — regression guard',
    async () => {
      // Arrange — hooks run pipe mode (stdoutToFile=false); official q()
      // routes the note to stderr there, which OCC already matches.
      const taskId = generateTaskId('local_bash')
      const taskOutput = new TaskOutput(taskId, null)
      const child = spawn('bash', ['-c', "printf 'wpq-pipe-311\\n'; sleep 10"], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const command = wrapSpawn(child, new AbortController().signal, TIMEOUT_MS, taskOutput, false)
      // Act
      const result = await command.result
      command.cleanup()
      // Assert
      expect(result.code).toBe(SIGTERM_CODE)
      expect(result.stderr).toContain('Command timed out after')
      expect(result.stdout).toContain('wpq-pipe-311')
      expect(result.stdout).not.toContain('Command timed out after')
    },
    15_000,
  )
})
