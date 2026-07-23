import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { truncate } from '../../utils/format.js'

export const OCC_WORDMARK = [
  '  ___   ___   ___ ',
  ' / _ \\ / __| / __|',
  '| (_) | (__ | (__  ',
  ' \\___/ \\___| \\___|',
] as const

const WELCOME_MAX_WIDTH = 84
const WIDE_MIN_COLUMNS = 76
const COMPACT_MIN_COLUMNS = 44
const SHIMMER_FRAME_MS = 84
const SHIMMER_DURATION_MS = 1_850
const SHIMMER_BAND_WIDTH = 0.24

export type OccWelcomeMode = 'wide' | 'compact' | 'plain'

export type OccWelcomeProps = {
  columns: number
  version: string
  model: string
  billing: string
  cwd: string
  branch?: string
  agentName?: string
  tip?: string
  reducedMotion: boolean
  plain?: boolean
  children?: React.ReactNode
}

type ShimmerRun = {
  text: string
  highlighted: boolean
}

export function getOccWelcomeMode(
  columns: number,
  plain = false,
): OccWelcomeMode {
  if (plain || columns < COMPACT_MIN_COLUMNS) return 'plain'
  if (columns < WIDE_MIN_COLUMNS) return 'compact'
  return 'wide'
}

export function formatWelcomeLocation(
  branch: string | undefined,
  cwd: string,
  maxWidth: number,
): string {
  const parts = [
    branch ? `git:${branch}` : undefined,
    cwd || undefined,
  ].filter((part): part is string => Boolean(part))
  const location = parts.length > 0 ? parts.join(' · ') : 'No project context'
  return truncate(location, Math.max(maxWidth, 1))
}

export function welcomeTip(
  mode: OccWelcomeMode,
  sessionTip?: string,
): string {
  if (sessionTip) return sessionTip
  if (mode === 'wide') {
    return 'Try /help for commands · /model to switch · /resume to continue'
  }
  if (mode === 'compact') {
    return '/help commands · /model switch · /resume continue'
  }
  return 'Type /help for commands'
}

/**
 * Build color runs for the one-shot diagonal shimmer.
 *
 * Progress is normalized to [0, 1]. The band starts and finishes outside the
 * wordmark, which avoids a hard flash on mount or when the animation settles.
 */
export function getShimmerRuns(
  line: string,
  row: number,
  progress: number | null,
): ShimmerRun[] {
  const chars = [...line]
  if (chars.length === 0) return []

  const runs: ShimmerRun[] = []
  for (let column = 0; column < chars.length; column++) {
    const char = chars[column]!
    const diagonal =
      (column + (OCC_WORDMARK.length - 1 - row) * 1.6) /
      (OCC_WORDMARK[0].length + OCC_WORDMARK.length * 1.6)
    const bandPosition =
      progress === null ? -1 : -SHIMMER_BAND_WIDTH + progress * 1.45
    const highlighted =
      progress !== null &&
      char !== ' ' &&
      Math.abs(diagonal - bandPosition) < SHIMMER_BAND_WIDTH
    const previous = runs[runs.length - 1]
    if (previous?.highlighted === highlighted) {
      previous.text += char
    } else {
      runs.push({ text: char, highlighted })
    }
  }
  return runs
}

function OccWordmark({
  animate,
}: {
  animate: boolean
}): React.ReactNode {
  const [done, setDone] = useState(!animate)
  const startTimeRef = useRef<number | null>(null)
  const [ref, time] = useAnimationFrame(done ? null : SHIMMER_FRAME_MS)

  useEffect(() => {
    if (done) return
    const timer = setTimeout(setDone, SHIMMER_DURATION_MS, true)
    return () => clearTimeout(timer)
  }, [done])

  if (startTimeRef.current === null) {
    startTimeRef.current = time
  }
  const elapsed = Math.max(0, time - startTimeRef.current)
  const progress = done
    ? null
    : Math.min(elapsed / SHIMMER_DURATION_MS, 1)

  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      {OCC_WORDMARK.map((line, row) => (
        <Text key={line}>
          {getShimmerRuns(line, row, progress).map((run, index) => (
            <Text
              key={`${row}-${index}`}
              color={run.highlighted ? 'claudeShimmer' : 'claude'}
              bold={run.highlighted}
            >
              {run.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

function Header({
  version,
  showTagline,
  width,
}: {
  version: string
  showTagline: boolean
  width: number
}): React.ReactNode {
  return (
    <Box width={width} justifyContent="space-between">
      <Text>
        <Text color="claude" bold>
          OCC
        </Text>
        <Text dimColor> v{version}</Text>
      </Text>
      {showTagline && (
        <Text dimColor wrap="truncate">
          Open C Code
        </Text>
      )}
    </Box>
  )
}

function Metadata({
  width,
  model,
  billing,
  location,
  agentName,
}: {
  width: number
  model: string
  billing: string
  location: string
  agentName?: string
}): React.ReactNode {
  const modelLine = truncate(`${model} · ${billing}`, Math.max(width, 1))
  const agentPrefix = agentName ? `@${agentName} · ` : ''
  const locationWidth = Math.max(width - stringWidth(agentPrefix), 1)

  return (
    <Box flexDirection="column" minWidth={0}>
      <Text bold>Ready when you are.</Text>
      <Text dimColor wrap="truncate">
        {modelLine}
      </Text>
      <Text wrap="truncate">
        {agentPrefix && <Text color="claude">{agentPrefix}</Text>}
        <Text dimColor>{truncate(location, locationWidth)}</Text>
      </Text>
      <Text dimColor wrap="truncate">
        Safe, open, and auditable.
      </Text>
    </Box>
  )
}

function PlainWelcome(props: OccWelcomeProps): React.ReactNode {
  const width = Math.max(props.columns, 1)
  const location = formatWelcomeLocation(props.branch, props.cwd, width)
  const modelLine = truncate(`${props.model} · ${props.billing}`, width)

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>OCC</Text>
        <Text dimColor> v{props.version} · Open C Code</Text>
      </Text>
      <Text dimColor wrap="truncate">
        {modelLine}
      </Text>
      <Text dimColor wrap="truncate">
        {location}
      </Text>
      <Text dimColor>{welcomeTip('plain', props.tip)}</Text>
      {props.children}
    </Box>
  )
}

export function OccWelcome(props: OccWelcomeProps): React.ReactNode {
  const mode = getOccWelcomeMode(props.columns, props.plain)
  if (mode === 'plain') {
    return <PlainWelcome {...props} />
  }

  const cardWidth = Math.min(Math.max(props.columns, 1), WELCOME_MAX_WIDTH)
  const contentWidth = Math.max(cardWidth - 4, 1)
  const location = formatWelcomeLocation(
    props.branch,
    props.cwd,
    mode === 'wide'
      ? Math.max(contentWidth - OCC_WORDMARK[0].length - 3, 1)
      : contentWidth,
  )
  const animate = !props.reducedMotion

  return (
    <Box
      width={cardWidth}
      flexDirection="column"
      borderStyle="round"
      borderColor="inactive"
      borderDimColor
      paddingX={1}
    >
      <Header
        version={props.version}
        showTagline
        width={contentWidth}
      />
      {mode === 'wide' ? (
        <Box marginTop={1} flexDirection="row" gap={3} alignItems="center">
          <OccWordmark animate={animate} />
          <Metadata
            width={Math.max(
              contentWidth - OCC_WORDMARK[0].length - 3,
              1,
            )}
            model={props.model}
            billing={props.billing}
            location={location}
            agentName={props.agentName}
          />
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column" alignItems="center">
          <OccWordmark animate={animate} />
          <Box marginTop={1} width={contentWidth}>
            <Metadata
              width={contentWidth}
              model={props.model}
              billing={props.billing}
              location={location}
              agentName={props.agentName}
            />
          </Box>
        </Box>
      )}
      <Box
        marginTop={1}
        borderStyle="single"
        borderColor="inactive"
        borderDimColor
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text dimColor wrap="truncate">
          {welcomeTip(mode, props.tip)}
        </Text>
      </Box>
      {props.children && <Box marginTop={1}>{props.children}</Box>}
    </Box>
  )
}
