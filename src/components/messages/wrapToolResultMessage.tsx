import * as React from 'react'
import { Text } from '../../ink.js'
import { logError } from '../../utils/log.js'

/** Dedup set: log the bare-primitive warning at most once per tool name. */
const warnedTools = new Set<string>()

/**
 * Guards the return value of `tool.renderToolResultMessage`. If a tool's
 * renderer returns a bare primitive (string, number, bigint) instead of a
 * React element, the session would crash when Ink tries to reconcile it.
 * This wraps the primitive in `<Text>` so it renders safely, and logs a
 * deduped warning so tool authors can fix the renderer.
 *
 * Matches the official 2.1.210 binary's `tpr` guard function:
 * - `typeof !== 'string' && !== 'number' && !== 'bigint'` → pass through
 * - bare primitive → wrap in `<Text>{value}</Text>` + log once per tool
 */
export function wrapToolResultMessage(
  rendered: React.ReactNode,
  tool: { name: string },
): React.ReactNode {
  if (
    typeof rendered !== 'string' &&
    typeof rendered !== 'number' &&
    typeof rendered !== 'bigint'
  ) {
    return rendered
  }

  if (!warnedTools.has(tool.name)) {
    warnedTools.add(tool.name)
    const bareType = typeof rendered
    queueMicrotask(() => {
      logError(
        new Error(
          `renderToolResultMessage returned a bare ${bareType} (tool: ${tool.name}) — wrapped in <Text>`,
        ),
      )
    })
  }

  return <Text>{rendered}</Text>
}
