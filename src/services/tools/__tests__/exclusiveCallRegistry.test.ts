import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetExclusiveCallRegistryForTesting,
  clearExclusiveCallQueuedBehind,
  type ExclusiveCallHold,
  getAutoBackgroundHoldReason,
  getExclusiveCallQueuedBehind,
  hasAutoBackgroundHold,
  setExclusiveCallQueuedBehind,
} from '../exclusiveCallRegistry.js'

/**
 * Official 2.1.295 #026: `Gn().exclusiveCallQueuedBehind=new Map` registry +
 * `Awn`/`a9r` hold-reason semantics. Binary (v295 @299997):
 *   function Awn(e){
 *     if(e.status!=="running"||e.isBackgrounded||e.toolUseId===void 0)return;
 *     let n=Gn().exclusiveCallQueuedBehind.get(e.toolUseId);
 *     if(n===void 0)return;
 *     if(!n.isQueued())return n.mayYetBeQueued()?"response_streaming":void 0;
 *     if(!n.holdLogged)n.holdLogged=!0,t(`[local-agent] subagent ${e.id} stays
 *       in the foreground: ...`),f("task_local_agent_auto_background","call_queued_behind");
 *     return"call_queued_behind"}
 *   function a9r(e){return Awn(e)!==void 0}
 */
function makeHold(
  isQueued: boolean,
  mayYetBeQueued: boolean,
): ExclusiveCallHold {
  return {
    isQueued: () => isQueued,
    mayYetBeQueued: () => mayYetBeQueued,
    holdLogged: false,
  }
}

const runningTask = {
  id: 'agent-1',
  status: 'running',
  isBackgrounded: false,
  toolUseId: 'tu_agent_1',
}

describe('CC 2.1.295 #026: exclusiveCallQueuedBehind registry', () => {
  beforeEach(() => {
    _resetExclusiveCallRegistryForTesting()
  })

  test('set/get round-trips a hold entry by tool-use id', () => {
    // Arrange
    const hold = makeHold(false, false)

    // Act
    setExclusiveCallQueuedBehind('tu1', hold)

    // Assert
    expect(getExclusiveCallQueuedBehind('tu1')).toBe(hold)
    expect(getExclusiveCallQueuedBehind('other')).toBeUndefined()
  })

  test('clear is identity-guarded — a stale clear never clobbers a newer entry (binary: if(T.get(e.id)===C)T.delete(e.id))', () => {
    // Arrange
    const older = makeHold(false, false)
    const newer = makeHold(true, false)
    setExclusiveCallQueuedBehind('tu1', older)
    setExclusiveCallQueuedBehind('tu1', newer)

    // Act — disposal of the OLDER hold must not delete the NEWER entry
    clearExclusiveCallQueuedBehind('tu1', older)

    // Assert
    expect(getExclusiveCallQueuedBehind('tu1')).toBe(newer)

    // Act — disposal of the current entry does delete it
    clearExclusiveCallQueuedBehind('tu1', newer)
    expect(getExclusiveCallQueuedBehind('tu1')).toBeUndefined()
  })
})

describe('CC 2.1.295 #026: Awn getAutoBackgroundHoldReason', () => {
  beforeEach(() => {
    _resetExclusiveCallRegistryForTesting()
  })

  test('returns undefined for a task that is not running', () => {
    // Arrange
    setExclusiveCallQueuedBehind('tu_agent_1', makeHold(true, true))

    // Act / Assert
    expect(
      getAutoBackgroundHoldReason({ ...runningTask, status: 'completed' }),
    ).toBeUndefined()
  })

  test('returns undefined for a task already backgrounded', () => {
    // Arrange
    setExclusiveCallQueuedBehind('tu_agent_1', makeHold(true, true))

    // Act / Assert
    expect(
      getAutoBackgroundHoldReason({ ...runningTask, isBackgrounded: true }),
    ).toBeUndefined()
  })

  test('returns undefined when the task has no toolUseId', () => {
    // Arrange
    setExclusiveCallQueuedBehind('tu_agent_1', makeHold(true, true))

    // Act / Assert
    expect(
      getAutoBackgroundHoldReason({ ...runningTask, toolUseId: undefined }),
    ).toBeUndefined()
  })

  test('returns undefined when no registry entry exists for the toolUseId', () => {
    // Act / Assert — empty registry
    expect(getAutoBackgroundHoldReason(runningTask)).toBeUndefined()
  })

  test('returns response_streaming when nothing is queued yet but the response is still open', () => {
    // Arrange — binary: `if(!n.isQueued())return n.mayYetBeQueued()?"response_streaming":void 0`
    setExclusiveCallQueuedBehind('tu_agent_1', makeHold(false, true))

    // Act / Assert
    expect(getAutoBackgroundHoldReason(runningTask)).toBe('response_streaming')
    expect(hasAutoBackgroundHold(runningTask)).toBe(true)
  })

  test('returns undefined when nothing is queued and the response is closed', () => {
    // Arrange
    setExclusiveCallQueuedBehind('tu_agent_1', makeHold(false, false))

    // Act / Assert
    expect(getAutoBackgroundHoldReason(runningTask)).toBeUndefined()
    expect(hasAutoBackgroundHold(runningTask)).toBe(false)
  })

  test('returns call_queued_behind and latches holdLogged once when an exclusive call is queued', () => {
    // Arrange
    const hold = makeHold(true, true)
    setExclusiveCallQueuedBehind('tu_agent_1', hold)
    expect(hold.holdLogged).toBe(false)

    // Act
    const first = getAutoBackgroundHoldReason(runningTask)
    const second = getAutoBackgroundHoldReason(runningTask)

    // Assert — reason is stable; the one-shot log latch flips exactly once
    expect(first).toBe('call_queued_behind')
    expect(second).toBe('call_queued_behind')
    expect(hold.holdLogged).toBe(true)
  })
})
