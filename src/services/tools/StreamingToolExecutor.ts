import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  createUserMessage,
  REJECT_MESSAGE,
  withMemoryCorrectionHint,
} from 'src/utils/messages.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { findToolByName, type Tools, type ToolUseContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createChildAbortController } from '../../utils/abortController.js'
import type { ToolDurationEntry } from '../api/gatewayHints.js'
import {
  clearExclusiveCallQueuedBehind,
  setExclusiveCallQueuedBehind,
} from './exclusiveCallRegistry.js'
import { runToolUse } from './toolExecution.js'

type MessageUpdate = {
  message?: Message
  newContext?: ToolUseContext
  // Official 2.1.273: the executor re-yields each tool's duration alongside
  // its results (`yield{message:B,newContext:...,toolDuration:O},O=void 0` —
  // attached to the FIRST result message only).
  toolDuration?: ToolDurationEntry
}

type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

type TrackedTool = {
  id: string
  block: ToolUseBlock
  assistantMessage: AssistantMessage
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  results?: Message[]
  // Official 2.1.273 (`h.toolDuration`): captured from the tool's result
  // stream, re-emitted once with the first buffered result message.
  toolDuration?: ToolDurationEntry
  // Progress messages are stored separately and yielded immediately
  pendingProgress: Message[]
  contextModifiers?: Array<(context: ToolUseContext) => ToolUseContext>
}

/**
 * Executes tools as they stream in with concurrency control.
 * - Concurrent-safe tools can execute in parallel with other concurrent-safe tools
 * - Non-concurrent tools must execute alone (exclusive access)
 * - Results are buffered and emitted in the order tools were received
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private toolUseContext: ToolUseContext
  private hasErrored = false
  private erroredToolDescription = ''
  // Child of toolUseContext.abortController. Fires when a Bash tool errors
  // so sibling subprocesses die immediately instead of running to completion.
  // Aborting this does NOT abort the parent — query.ts won't end the turn.
  private siblingAbortController: AbortController
  private discarded = false
  // Official 2.1.295 (`responseOpen=!0`): true while the model response is
  // still streaming (more tool calls — possibly exclusive ones — may yet be
  // queued); flipped to false at the top of getRemainingResults(), matching
  // the binary (`if(this.responseOpen=!1,this.discarded)return`).
  private responseOpen = true
  // Official 2.1.295 (#072, binary v295 `appliedLayers=!1` @ ~223344772;
  // v294 had `appliedConcurrencySafeLayers=!1` @ ~220834890): set when a
  // non-concurrency-safe tool applies its context modifiers immediately in
  // executeTool. getRemainingResults() gates its final `yield{newContext}`
  // on this flag so a skill's allowed-tools/effort — applied when the Skill
  // tool finished BEFORE the response stream ended (its result message was
  // already drained mid-stream by getCompletedResults, whose consumer
  // ignores newContext, matching the official `vn` consumer @ v295
  // ~223441153) — still reaches the next turn instead of being dropped.
  private appliedLayers = false
  // Signal to wake up getRemainingResults when progress is available
  private progressAvailableResolve?: () => void

  constructor(
    private readonly toolDefinitions: Tools,
    private readonly canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
  ) {
    this.toolUseContext = toolUseContext
    this.siblingAbortController = createChildAbortController(
      toolUseContext.abortController,
    )
  }

  /**
   * Discards all pending and in-progress tools. Called when streaming fallback
   * occurs and results from the failed attempt should be abandoned.
   * Queued tools won't start, and in-progress tools will receive synthetic errors.
   */
  discard(): void {
    this.discarded = true
  }

  /**
   * Add a tool to the execution queue. Will start executing immediately if conditions allow.
   */
  addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void {
    const toolDefinition = findToolByName(this.toolDefinitions, block.name)
    if (!toolDefinition) {
      this.tools.push({
        id: block.id,
        block,
        assistantMessage,
        status: 'completed',
        isConcurrencySafe: true,
        pendingProgress: [],
        results: [
          createUserMessage({
            content: [
              {
                type: 'tool_result',
                content: `<tool_use_error>Error: No such tool available: ${block.name}</tool_use_error>`,
                is_error: true,
                tool_use_id: block.id,
              },
            ],
            toolUseResult: `Error: No such tool available: ${block.name}`,
            sourceToolAssistantUUID: assistantMessage.uuid,
          }),
        ],
      })
      return
    }

    const parsedInput = toolDefinition.inputSchema.safeParse(block.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(toolDefinition.isConcurrencySafe(parsedInput.data))
          } catch {
            return false
          }
        })()
      : false
    this.tools.push({
      id: block.id,
      block,
      assistantMessage,
      status: 'queued',
      isConcurrencySafe,
      pendingProgress: [],
    })

    void this.processQueue()
  }

  /**
   * Check if a tool can execute based on current concurrency state
   */
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter(t => t.status === 'executing')
    return (
      executingTools.length === 0 ||
      (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
    )
  }

  /**
   * Process the queue, starting tools when concurrency conditions allow
   */
  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool)
      } else {
        // Can't execute this tool yet, and since we need to maintain order for non-concurrent tools, stop here
        if (!tool.isConcurrencySafe) break
      }
    }
  }

  private createSyntheticErrorMessage(
    toolUseId: string,
    reason: 'sibling_error' | 'user_interrupted' | 'streaming_fallback',
    assistantMessage: AssistantMessage,
  ): Message {
    // For user interruptions (ESC to reject), use REJECT_MESSAGE so the UI shows
    // "User rejected edit" instead of "Error editing file"
    if (reason === 'user_interrupted') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: withMemoryCorrectionHint(REJECT_MESSAGE),
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
        toolUseResult: 'User rejected tool use',
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
    if (reason === 'streaming_fallback') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content:
              '<tool_use_error>Error: Streaming fallback - tool execution discarded</tool_use_error>',
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
        toolUseResult: 'Streaming fallback - tool execution discarded',
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
    const desc = this.erroredToolDescription
    const msg = desc
      ? `Cancelled: parallel tool call ${desc} errored`
      : 'Cancelled: parallel tool call errored'
    return createUserMessage({
      content: [
        {
          type: 'tool_result',
          content: `<tool_use_error>${msg}</tool_use_error>`,
          is_error: true,
          tool_use_id: toolUseId,
        },
      ],
      toolUseResult: msg,
      sourceToolAssistantUUID: assistantMessage.uuid,
    })
  }

  /**
   * Determine why a tool should be cancelled.
   */
  private getAbortReason(
    tool: TrackedTool,
  ): 'sibling_error' | 'user_interrupted' | 'streaming_fallback' | null {
    if (this.discarded) {
      return 'streaming_fallback'
    }
    if (this.hasErrored) {
      return 'sibling_error'
    }
    if (this.toolUseContext.abortController.signal.aborted) {
      // 'interrupt' means the user typed a new message while tools were
      // running. Only cancel tools whose interruptBehavior is 'cancel';
      // 'block' tools shouldn't reach here (abort isn't fired).
      if (this.toolUseContext.abortController.signal.reason === 'interrupt') {
        return this.getToolInterruptBehavior(tool) === 'cancel'
          ? 'user_interrupted'
          : null
      }
      return 'user_interrupted'
    }
    return null
  }

  private getToolInterruptBehavior(tool: TrackedTool): 'cancel' | 'block' {
    const definition = findToolByName(this.toolDefinitions, tool.block.name)
    if (!definition?.interruptBehavior) return 'block'
    try {
      return definition.interruptBehavior()
    } catch {
      return 'block'
    }
  }

  private getToolDescription(tool: TrackedTool): string {
    const input = tool.block.input as Record<string, unknown> | undefined
    const summary = input?.command ?? input?.file_path ?? input?.pattern ?? ''
    if (typeof summary === 'string' && summary.length > 0) {
      const truncated =
        summary.length > 40 ? summary.slice(0, 40) + '\u2026' : summary
      return `${tool.block.name}(${truncated})`
    }
    return tool.block.name
  }

  private updateInterruptibleState(): void {
    const executing = this.tools.filter(t => t.status === 'executing')
    this.toolUseContext.setHasInterruptibleToolInProgress?.(
      executing.length > 0 &&
        executing.every(t => this.getToolInterruptBehavior(t) === 'cancel'),
    )
  }

  /**
   * Execute a tool and collect its results
   */
  private async executeTool(tool: TrackedTool): Promise<void> {
    tool.status = 'executing'
    this.toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(tool.id),
    )
    this.updateInterruptibleState()

    const messages: Message[] = []
    const contextModifiers: Array<(context: ToolUseContext) => ToolUseContext> =
      []

    const collectResults = async () => {
      // If already aborted (by error or user), generate synthetic error block instead of running the tool
      const initialAbortReason = this.getAbortReason(tool)
      if (initialAbortReason) {
        messages.push(
          this.createSyntheticErrorMessage(
            tool.id,
            initialAbortReason,
            tool.assistantMessage,
          ),
        )
        tool.results = messages
        tool.contextModifiers = contextModifiers
        tool.status = 'completed'
        this.updateInterruptibleState()
        return
      }

      // Per-tool child controller. Lets siblingAbortController kill running
      // subprocesses (Bash spawns listen to this signal) when a Bash error
      // cascades. Permission-dialog rejection also aborts this controller
      // (PermissionContext.ts cancelAndAbort) — that abort must bubble up to
      // the query controller so the query loop's post-tool abort check ends
      // the turn. Without bubble-up, ExitPlanMode "clear context + auto"
      // sends REJECT_MESSAGE to the model instead of aborting (#21056 regression).
      const toolAbortController = createChildAbortController(
        this.siblingAbortController,
      )
      toolAbortController.signal.addEventListener(
        'abort',
        () => {
          if (
            toolAbortController.signal.reason !== 'sibling_error' &&
            !this.toolUseContext.abortController.signal.aborted &&
            !this.discarded
          ) {
            this.toolUseContext.abortController.abort(
              toolAbortController.signal.reason,
            )
          }
        },
        { once: true },
      )

      // Official 2.1.295 (#026): register this executing call in the global
      // exclusiveCallQueuedBehind registry so auto-background can refuse to
      // move a subagent to the background while a tool call that must run
      // alone is queued behind its Agent call. Binary:
      //   C={isQueued:()=>!this.discarded&&this.tools.slice(this.tools.indexOf(e)+1)
      //        .some((R)=>R.status==="queued"&&!R.isConcurrencySafe),
      //      mayYetBeQueued:()=>!this.discarded&&this.responseOpen,holdLogged:!1};
      //   T.set(e.id,C); using S={[Symbol.dispose]:()=>{if(T.get(e.id)===C)T.delete(e.id)}}
      // The `using` disposal maps to the finally-block clear below (identity-
      // guarded inside clearExclusiveCallQueuedBehind).
      const hold = {
        isQueued: () =>
          !this.discarded &&
          this.tools
            .slice(this.tools.indexOf(tool) + 1)
            .some(t => t.status === 'queued' && !t.isConcurrencySafe),
        mayYetBeQueued: () => !this.discarded && this.responseOpen,
        holdLogged: false,
      }
      setExclusiveCallQueuedBehind(tool.id, hold)

      const generator = runToolUse(
        tool.block,
        tool.assistantMessage,
        this.canUseTool,
        { ...this.toolUseContext, abortController: toolAbortController },
      )

      // Track if this specific tool has produced an error result.
      // This prevents the tool from receiving a duplicate "sibling error"
      // message when it is the one that caused the error.
      let thisToolErrored = false

      try {
        for await (const update of generator) {
          // Check if we were aborted by a sibling tool error or user interruption.
          // Only add the synthetic error if THIS tool didn't produce the error.
          const abortReason = this.getAbortReason(tool)
          if (abortReason && !thisToolErrored) {
            messages.push(
              this.createSyntheticErrorMessage(
                tool.id,
                abortReason,
                tool.assistantMessage,
              ),
            )
            break
          }

          const isErrorResult =
            update.message.type === 'user' &&
            Array.isArray(update.message.message.content) &&
            update.message.message.content.some(
              _ => _.type === 'tool_result' && _.is_error === true,
            )

          if (isErrorResult) {
            thisToolErrored = true
            // Only Bash errors cancel siblings. Bash commands often have implicit
            // dependency chains (e.g. mkdir fails → subsequent commands pointless).
            // Read/WebFetch/etc are independent — one failure shouldn't nuke the rest.
            if (tool.block.name === BASH_TOOL_NAME) {
              this.hasErrored = true
              this.erroredToolDescription = this.getToolDescription(tool)
              this.siblingAbortController.abort('sibling_error')
            }
          }

          if (update.message) {
            // Progress messages go to pendingProgress for immediate yielding
            if (update.message.type === 'progress') {
              tool.pendingProgress.push(update.message)
              // Signal that progress is available
              if (this.progressAvailableResolve) {
                this.progressAvailableResolve()
                this.progressAvailableResolve = undefined
              }
            } else {
              messages.push(update.message)
            }
          }
          if (update.contextModifier) {
            contextModifiers.push(update.contextModifier.modifyContext)
          }
          if (update.toolDuration) {
            tool.toolDuration = update.toolDuration
          }
        }
        tool.results = messages
        tool.contextModifiers = contextModifiers
        tool.status = 'completed'
        this.updateInterruptibleState()

        // NOTE: we currently don't support context modifiers for concurrent
        //       tools. None are actively being used, but if we want to use
        //       them in concurrent tools, we need to support that here.
        if (!tool.isConcurrencySafe && contextModifiers.length > 0) {
          for (const modifier of contextModifiers) {
            this.toolUseContext = modifier(this.toolUseContext)
          }
          // Official 2.1.295 (#072, binary v295 @ ~223352019:
          // `this.toolUseContext=WAe(this.toolUseContext,n),this.appliedLayers=!0`
          // — v294 applied the layers here WITHOUT setting any flag, so when
          // the tool's messages were consumed mid-stream the applied context
          // was never re-surfaced after the stream ended).
          this.appliedLayers = true
        }
      } finally {
        clearExclusiveCallQueuedBehind(tool.id, hold)
      }
    }

    const promise = collectResults()
    tool.promise = promise

    // Process more queue when done
    void promise.finally(() => {
      void this.processQueue()
    })
  }

  /**
   * Get any completed results that haven't been yielded yet (non-blocking)
   * Maintains order where necessary
   * Also yields any pending progress messages immediately
   */
  *getCompletedResults(): Generator<MessageUpdate, void> {
    if (this.discarded) {
      return
    }

    for (const tool of this.tools) {
      // Always yield pending progress messages immediately, regardless of tool status
      while (tool.pendingProgress.length > 0) {
        const progressMessage = tool.pendingProgress.shift()!
        yield { message: progressMessage, newContext: this.toolUseContext }
      }

      if (tool.status === 'yielded') {
        continue
      }

      if (tool.status === 'completed' && tool.results) {
        tool.status = 'yielded'

        // Official 2.1.273 executor yield (byte-verified):
        // `let O=h.toolDuration;for(let B of h.results)
        //    yield{message:B,newContext:this.toolUseContext,toolDuration:O},
        //    O=void 0` — duration rides on the FIRST result message only.
        let toolDuration = tool.toolDuration
        for (const message of tool.results) {
          yield { message, newContext: this.toolUseContext, toolDuration }
          toolDuration = undefined
        }

        markToolUseAsComplete(this.toolUseContext, tool.id)
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        break
      }
    }
  }

  /**
   * Check if any tool has pending progress messages
   */
  private hasPendingProgress(): boolean {
    return this.tools.some(t => t.pendingProgress.length > 0)
  }

  /**
   * Wait for remaining tools and yield their results as they complete
   * Also yields progress messages as they become available
   */
  async *getRemainingResults(): AsyncGenerator<MessageUpdate, void> {
    // Official 2.1.295 (#026): the response is closed once the caller starts
    // draining remaining results — no more exclusive calls can be queued after
    // this point (binary: `if(this.responseOpen=!1,this.discarded)return`).
    this.responseOpen = false
    if (this.discarded) {
      return
    }

    while (this.hasUnfinishedTools()) {
      await this.processQueue()

      for (const result of this.getCompletedResults()) {
        yield result
      }

      // If we still have executing tools but nothing completed, wait for any to complete
      // OR for progress to become available
      if (
        this.hasExecutingTools() &&
        !this.hasCompletedResults() &&
        !this.hasPendingProgress()
      ) {
        const executingPromises = this.tools
          .filter(t => t.status === 'executing' && t.promise)
          .map(t => t.promise!)

        // Also wait for progress to become available
        const progressPromise = new Promise<void>(resolve => {
          this.progressAvailableResolve = resolve
        })

        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise])
        }
      }
    }

    for (const result of this.getCompletedResults()) {
      yield result
    }

    // Official 2.1.295 (#072, binary v295 @ ~223353300:
    // `if(this.applyEndedRunLayers(),this.appliedLayers)yield{newContext:this.toolUseContext}`
    // — v294 gated on `appliedConcurrencySafeLayers`, which the non-
    // concurrency-safe immediate-apply path never set; a Skill tool that
    // finished before the stream ended had its result message (the only
    // carrier of newContext) drained mid-stream, so its applied allowed-
    // tools/effort never reached the post-stream consumer and the next turn
    // denied the skill's Bash in `-p` runs). OCC has no applyEndedRunLayers
    // (deferred concurrency-safe layer application is intentionally
    // unsupported — see the NOTE in executeTool), so the comma operator
    // collapses to the flag check.
    if (this.appliedLayers) {
      yield { newContext: this.toolUseContext }
    }
  }

  /**
   * Check if there are any completed results ready to yield
   */
  private hasCompletedResults(): boolean {
    return this.tools.some(t => t.status === 'completed')
  }

  /**
   * Check if there are any tools still executing
   */
  private hasExecutingTools(): boolean {
    return this.tools.some(t => t.status === 'executing')
  }

  /**
   * Check if there are any unfinished tools
   */
  private hasUnfinishedTools(): boolean {
    return this.tools.some(t => t.status !== 'yielded')
  }

  /**
   * Get the current tool use context (may have been modified by context modifiers)
   */
  getUpdatedContext(): ToolUseContext {
    return this.toolUseContext
  }
}

function markToolUseAsComplete(
  toolUseContext: ToolUseContext,
  toolUseID: string,
) {
  toolUseContext.setInProgressToolUseIDs(prev => {
    const next = new Set(prev)
    next.delete(toolUseID)
    return next
  })
}
