import * as React from 'react'
import { createContext, useContext } from 'react'
import { Box, Text } from '../../ink.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import type { Message, SystemCompactBoundaryMessage } from '../../types/message.js'
import { getDisplayPath } from '../../utils/file.js'
import { formatTokens } from '../../utils/format.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { stripInvisibleUnicode } from '../../utils/invisibleUnicode.js'
import { getContentText, isCompactBoundaryMessage } from '../../utils/messages.js'

/**
 * CC 2.1.301 changelog #28 — the compaction row in a resumed session must not
 * offer ctrl+o for history that is not loaded; it must say where the earlier
 * messages are saved, and also show in fullscreen.
 *
 * This module ports the official v301 mechanics (all byte-verified against the
 * v301 linux-x64 binary with grep -aboF + dd; never executed):
 *
 *   Tx  — transcript-path scanner prompt text (byte-identical constant below;
 *         OCC already persists the same string via getCompactUserSummaryMessage,
 *         src/services/compact/prompt.ts:353)
 *   F7n @247669073 — leading-boundary scanner → findCompactSummaryInfo
 *   dd  — detail helper → compactBoundaryDetail
 *   dGr — scan + uuid match + dd → conversationSummarizedDetail
 *   Jm  @247543200 — fullscreen manual-trigger gate → shouldShowFullscreenCompactRow
 *   Zm  @247543300 — fullscreen row builder → buildCompactedRow
 *   pd  @247669764 — the component below
 *   provider @247932600 — savedIn guard (parsed path must equal the CURRENT
 *         session transcript path) → applySavedInGuard (applied REPL-side)
 *   xzt/P9e/$ee — path validity guards → savedInDisplayPath
 *   ts  @217543191 — display-path shortener → getDisplayPath (src/utils/file.ts)
 *
 * OCC adaptation: the official threads the scan through a React context (_zt)
 * from the REPL provider; OCC does the same (CompactSummaryContext below,
 * provided in REPL.tsx). The official's fullscreen row renderer (`Ne`) was not
 * recoverable from the binary, so buildCompactedRow returns Zm's exact data
 * shape and the component renders it as a minimal dim Text row.
 */

/**
 * Official v301 `Tx` — byte-exact (trailing space included). This is the same
 * marker getCompactUserSummaryMessage appends before the transcript path.
 */
export const COMPACT_TRANSCRIPT_PROMPT =
  'If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: '

export type CompactSummaryInfo = {
  uuid: string
  /**
   * null    — the boundary leads the list but no compact-summary message was
   *           found after it (nothing to point a shortcut at).
   * object  — summary found; transcriptPath is the path parsed out of it
   *           (undefined when the summary carries no Tx marker or the
   *           provider-side guard dropped it).
   */
  summary: { transcriptPath: string | undefined } | null
}

/**
 * Official F7n @247669073. Returns non-null ONLY when the first real
 * conversation message (user/assistant/compact-boundary) is a compact boundary
 * with a usable uuid — i.e. the pre-compaction history is NOT loaded in this
 * message list. Then scans forward (stopping at the next boundary) for the
 * compact-summary user message and parses the transcript path out of it:
 * `lastIndexOf(\`\n${Tx}\`)` → slice to the next `\n` (the path may be followed
 * by a "Continue the conversation…" line when suppressFollowUpQuestions).
 */
export function findCompactSummaryInfo(
  messages: ReadonlyArray<Message>,
): CompactSummaryInfo | null {
  const leadIndex = messages.findIndex(
    m => m?.type === 'user' || m?.type === 'assistant' || isCompactBoundaryMessage(m),
  )
  const lead = leadIndex === -1 ? undefined : messages[leadIndex]
  if (lead === undefined || !isCompactBoundaryMessage(lead) || !lead.uuid) {
    return null
  }
  const boundaryUuid = String(lead.uuid)

  let summaryText: string | null | undefined
  for (let i = leadIndex + 1; i < messages.length; i++) {
    const candidate = messages[i]
    if (!candidate) continue
    if (isCompactBoundaryMessage(candidate)) break
    if (candidate.type === 'user' && candidate.isCompactSummary) {
      const content = candidate.message?.content
      summaryText = content === undefined ? null : getContentText(content as never)
      break
    }
  }

  if (summaryText === undefined) {
    return { uuid: boundaryUuid, summary: null }
  }
  const markerIndex = summaryText?.lastIndexOf(`\n${COMPACT_TRANSCRIPT_PROMPT}`) ?? -1
  if (summaryText === null || markerIndex === -1) {
    return { uuid: boundaryUuid, summary: { transcriptPath: undefined } }
  }
  const pathStart = markerIndex + 1 + COMPACT_TRANSCRIPT_PROMPT.length
  const lineEnd = summaryText.indexOf('\n', pathStart)
  return {
    uuid: boundaryUuid,
    summary: {
      transcriptPath: summaryText.slice(pathStart, lineEnd === -1 ? undefined : lineEnd),
    },
  }
}

/**
 * Official dd — the parenthetical after "Conversation compacted":
 *   info null (history loaded / boundary not matched) → offer the shortcut
 *     "for history" (the transcript view shows the loaded messages);
 *   summary null (nothing after the boundary yet) → no hint at all;
 *   summary found → offer the shortcut "for the summary".
 */
export function compactBoundaryDetail(
  info: CompactSummaryInfo | null,
  shortcut: string,
): string {
  if (info === null) return ` (${shortcut} for history)`
  return info.summary === null ? '' : ` (${shortcut} for the summary)`
}

/**
 * Official dGr — the "Conversation summarized" notification detail: scan the
 * live message list and only honor the match when the scan keyed on THIS
 * boundary's uuid (otherwise fall back to the history offer).
 */
export function conversationSummarizedDetail(
  messages: ReadonlyArray<Message>,
  boundaryUuid: string | undefined,
  shortcut: string,
): string {
  const scan = findCompactSummaryInfo(messages)
  return compactBoundaryDetail(scan?.uuid === boundaryUuid ? scan : null, shortcut)
}

/**
 * Official provider guard @247932600 — `savedIn: nc===td()?nc:void 0`: only
 * surface the parsed transcript path when it equals the CURRENT session's
 * transcript file (a forked/resumed-into-new-file session must not claim the
 * old path holds "earlier messages"). The official also skips the comparison
 * entirely for thin-client/local-GC modes; OCC has neither, so no extra guard.
 */
export function applySavedInGuard(
  scan: CompactSummaryInfo | null,
  currentTranscriptPath: string | null,
): CompactSummaryInfo | null {
  if (scan === null || scan.summary === null) return scan
  const kept =
    scan.summary.transcriptPath !== undefined &&
    scan.summary.transcriptPath === currentTranscriptPath
  return {
    uuid: scan.uuid,
    summary: { transcriptPath: kept ? scan.summary.transcriptPath : undefined },
  }
}

/**
 * Official `xzt` validity guard + `ts` display shortener. xzt = P9e(ke(path)):
 * P9e rejects C0/C1 control characters (/[\u0000-\u001f\u007f-\u009f]/) or
 * any invisible character ($ee scanner). OCC adaptation: $ee's per-codepoint
 * classifier maps to stripInvisibleUnicode (src/utils/invisibleUnicode.ts —
 * the same official m4r classifier OCC already ports); ke's case-folding for
 * case-insensitive filesystems has no bearing on the character scan. ts maps
 * to getDisplayPath (cwd-relative → ~-home → absolute).
 */
export function savedInDisplayPath(transcriptPath: string | undefined): string | undefined {
  if (transcriptPath === undefined || transcriptPath === '') return undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char matcher (official v301 P9e path guard)
  if (/[\u0000-\u001f\u007f-\u009f]/.test(transcriptPath)) return undefined
  if (stripInvisibleUnicode(transcriptPath).removedTotal > 0) return undefined
  return getDisplayPath(transcriptPath)
}

/**
 * Official Jm @247543200 — fullscreen gate: never render without
 * compactMetadata, and suppress a MANUAL compaction's row when the fullscreen
 * context did not match this boundary (`O = f && b === null` in pd — the
 * fullscreen view already shows the messages the user just summarized).
 */
export function shouldShowFullscreenCompactRow(
  compactMetadata: { trigger?: unknown } | undefined,
  isFullscreenWithoutMatchedSummary: boolean,
): boolean {
  return (
    compactMetadata !== undefined &&
    !(isFullscreenWithoutMatchedSummary && compactMetadata.trigger === 'manual')
  )
}

export type CompactedRowContext = {
  leadsToSummary: boolean
  savedIn?: string
} | null

export type CompactedRow = {
  tone: 'dim'
  text: string
  detail: string | undefined
  subLines?: string[]
  linkify: boolean
}

/**
 * Official Zm @247543300 — fullscreen "Compacted" row data. Exact port of the
 * official field logic (count text prefers messagesSummarized over preTokens,
 * hint selection, byte-verbatim `Earlier messages are saved in ` subline,
 * conditional spread so subLines is absent when savedIn is undefined).
 */
export function buildCompactedRow(
  compactMetadata: { preTokens?: number; messagesSummarized?: number },
  shortcut: string,
  context: CompactedRowContext,
): CompactedRow {
  const messagesSummarized = compactMetadata.messagesSummarized
  const preTokens = compactMetadata.preTokens ?? 0
  const countText =
    messagesSummarized !== undefined && messagesSummarized > 0
      ? `${messagesSummarized} ${messagesSummarized === 1 ? 'message' : 'messages'} summarized`
      : preTokens > 0
        ? `${formatTokens(preTokens)} tokens summarized`
        : null
  const hint =
    context === null
      ? countText
        ? 'to see them'
        : 'for history'
      : context.leadsToSummary
        ? 'for the summary'
        : null
  const savedIn = context?.savedIn
  return {
    tone: 'dim',
    text: 'Compacted',
    detail:
      hint === null
        ? countText ?? undefined
        : countText
          ? `${countText} (${shortcut} ${hint})`
          : `${shortcut} ${hint}`,
    ...(savedIn !== undefined && { subLines: [`Earlier messages are saved in ${savedIn}`] }),
    linkify: false,
  }
}

/**
 * Scan result threaded REPL → boundary component (official _zt context).
 * The REPL provides findCompactSummaryInfo(messages) after applySavedInGuard;
 * null default = "history is loaded / nothing known" → classic ctrl+o offer.
 */
export const CompactSummaryContext = createContext<CompactSummaryInfo | null>(null)

type CompactBoundaryMessageProps = {
  /**
   * The boundary message being rendered. OPTIONAL — OCC's Message.tsx
   * currently renders <CompactBoundaryMessage /> with no props (official pd
   * receives the message and uuid-matches the context against it). Without
   * the prop the context is applied unconditionally, which is safe: the
   * classic list only renders a boundary that is the leading message
   * (non-fullscreen compaction resets the list to [boundary, …] and
   * Messages.tsx filters everything before the last boundary) — exactly the
   * message the scanner keys on.
   */
  message?: SystemCompactBoundaryMessage
}

export function CompactBoundaryMessage({ message }: CompactBoundaryMessageProps) {
  const historyShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  const scan = useContext(CompactSummaryContext)
  const isFullscreen = isFullscreenEnvEnabled()

  // Official pd: `b = M !== null && M.uuid === d.uuid ? M : null`
  const matched = message
    ? scan !== null && scan.uuid === String(message.uuid)
      ? scan
      : null
    : scan

  const savedInShown = savedInDisplayPath(matched?.summary?.transcriptPath)
  const compactMetadata = message?.compactMetadata as
    | { trigger?: string; preTokens?: number; messagesSummarized?: number }
    | undefined

  // Official `O = f && b === null` — fullscreen and the context did not match.
  const fullscreenWithoutMatchedSummary = isFullscreen && matched === null

  if (isFullscreen && shouldShowFullscreenCompactRow(compactMetadata, fullscreenWithoutMatchedSummary)) {
    const row = buildCompactedRow(
      compactMetadata ?? { preTokens: 0 },
      historyShortcut,
      matched
        ? { leadsToSummary: matched.summary !== null, savedIn: savedInShown }
        : null,
    )
    // OCC adaptation: the official `Ne` row renderer was not recoverable from
    // the binary; render Zm's data shape as a minimal dim row (this branch is
    // dormant until Message.tsx stops returning null for fullscreen
    // compact_boundary — tracked as an out-of-scope one-liner).
    return (
      <Box marginY={1} flexDirection="column">
        <Text dimColor={true}>
          ✻ {row.text}
          {row.detail ? ` ${row.detail}` : ''}
        </Text>
        {row.subLines?.map(line => (
          <Box key={line} paddingLeft={2}>
            <Text dimColor={true}>{line}</Text>
          </Box>
        ))}
      </Box>
    )
  }

  // Official pd: `if (O) return null` — never double-render in fullscreen.
  if (fullscreenWithoutMatchedSummary) return null

  return (
    <Box marginY={1} flexDirection="column">
      <Text dimColor={true}>
        ✻ Conversation compacted{compactBoundaryDetail(matched, historyShortcut)}
      </Text>
      {savedInShown !== undefined ? (
        <Box paddingLeft={2}>
          <Text dimColor={true}>Earlier messages are saved in {savedInShown}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
