/**
 * CC 2.1.285: "Fixed a cancelled shell command or hook still starting, and
 * running to its end, when the cancel arrived while it was being set up."
 *
 * Byte evidence (linux-x64 official ELFs, JS region):
 * - v284 constructor tail @205214450+900 region:
 *   `this.result=this.#P(),this.#m.liveShellCommands.add(this)}`
 * - v285 constructor tail @202981550+900 region:
 *   `if(this.result=this.#P(),this.#m.liveShellCommands.add(this),n.aborted)this.#b()}`
 *   — the ONLY delta is the trailing `,n.aborted)this.#b()` already-aborted
 *   check (`#b` = v284's `#T` abort handler: interrupt-exempt, else kill()).
 *
 * An AbortSignal aborted before addEventListener never fires, so without the
 * constructor check the command runs to its end. OCC port:
 * ShellCommandImpl constructor now calls #abortHandler() when
 * abortSignal.aborted is already true.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, test } from 'bun:test'
import { generateTaskId } from '../../Task.js'
import { wrapSpawn } from '../ShellCommand.js'
import { TaskOutput } from '../task/TaskOutput.js'

function makeFakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number
    stdout: null
    stderr: null
    kill: () => boolean
  }
  // No pid: treeKill is skipped, so no real process is signalled.
  child.pid = undefined
  child.stdout = null
  child.stderr = null
  child.kill = () => true
  return child as unknown as ChildProcess
}

function makeTaskOutput(): TaskOutput {
  return new TaskOutput(generateTaskId('local_bash'), null)
}

describe('CC 2.1.285 ShellCommand pre-aborted construction', () => {
  test('kills immediately when the signal was already aborted at construction', async () => {
    // Arrange
    const controller = new AbortController()
    controller.abort()

    // Act
    const command = wrapSpawn(
      makeFakeChild(),
      controller.signal,
      60_000,
      makeTaskOutput(),
    )

    // Assert — v285 `n.aborted → this.#b()` → kill(): status 'killed' and the
    // result promise resolves with the SIGKILL exit shape instead of hanging
    // until the (never-started) child exits.
    expect(command.status).toBe('killed')
    const result = await command.result
    expect(result.code).toBe(137)
    expect(result.interrupted).toBe(true)
    command.cleanup()
  })

  test('honors the interrupt exemption for a pre-aborted interrupt reason', () => {
    // Arrange — official #b(): `reason === 'interrupt'` returns without kill.
    const controller = new AbortController()
    controller.abort('interrupt')

    // Act
    const command = wrapSpawn(
      makeFakeChild(),
      controller.signal,
      60_000,
      makeTaskOutput(),
    )

    // Assert — not killed; caller backgrounds the process for partial output.
    expect(command.status).toBe('running')
    command.kill()
    command.cleanup()
  })

  test('leaves a non-aborted command running (regression guard)', () => {
    // Arrange
    const controller = new AbortController()

    // Act
    const command = wrapSpawn(
      makeFakeChild(),
      controller.signal,
      60_000,
      makeTaskOutput(),
    )

    // Assert
    expect(command.status).toBe('running')
    command.kill()
    command.cleanup()
  })

  test('still kills via the abort listener when the cancel arrives after construction', async () => {
    // Arrange
    const controller = new AbortController()
    const command = wrapSpawn(
      makeFakeChild(),
      controller.signal,
      60_000,
      makeTaskOutput(),
    )

    // Act — pre-existing listener path (unchanged by the 2.1.285 port).
    controller.abort()

    // Assert
    expect(command.status).toBe('killed')
    const result = await command.result
    expect(result.interrupted).toBe(true)
    command.cleanup()
  })
})
