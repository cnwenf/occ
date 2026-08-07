import * as React from 'react'
import { Box, color, Text } from '../../ink.js'
import { truncate } from '../../utils/format.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import {
  getOccMark,
  getOccMarkWidth,
  OccMark,
  type OccMarkMode,
} from './OccMark.js'

const WELCOME_MAX_WIDTH = 84
const WIDE_MIN_COLUMNS = 76
const COMPACT_MIN_COLUMNS = 44
const LABEL_COLUMN_WIDTH = 7

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
 * HUD-style key/value readout row: a dim uppercase micro-label in a fixed
 * column, then the live value. Keeps startup context scannable the way a
 * status panel reads, instead of a prose block.
 */
function DataRow({
  label,
  value,
  width,
}: {
  label: string
  value: string
  width: number
}): React.ReactNode {
  const labelCell = `${label}  `.slice(0, LABEL_COLUMN_WIDTH).padEnd(LABEL_COLUMN_WIDTH)
  return (
    <Text wrap="truncate">
      <Text color="inactive">{labelCell}</Text>
      <Text>{truncate(value, Math.max(width - LABEL_COLUMN_WIDTH, 1))}</Text>
    </Text>
  )
}

/** Dashed HUD separator rendered as text so it stays double-dash styled. */
function DashedRule({ width }: { width: number }): React.ReactNode {
  return (
    <Text color="inactive" dimColor wrap="truncate">
      {'╌'.repeat(Math.max(width, 1))}
    </Text>
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
  const locationValue = `${agentPrefix}${location}`

  return (
    <Box flexDirection="column" minWidth={0}>
      <Text bold wrap="truncate">
        Ready when you are.
      </Text>
      <DataRow label="MODEL" value={modelLine} width={width} />
      <DataRow label="PROJ" value={locationValue} width={width} />
    </Box>
  )
}

function PlainWelcome(props: OccWelcomeProps): React.ReactNode {
  const width = Math.max(props.columns, 1)
  const location = formatWelcomeLocation(props.branch, props.cwd, width)
  const modelLine = truncate(`${props.model} · ${props.billing}`, width)
  const logo = getOccMark('plain')
  const showLogo = !props.plain && width >= getOccMarkWidth(logo)
  const animate = !props.reducedMotion && !props.plain

  return (
    <Box flexDirection="column">
      {showLogo && (
        <Box marginBottom={1}>
          <OccMark mode="plain" animate={animate} />
        </Box>
      )}
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

/**
 * The OCC welcome card (OCC-45 HUD system, OCC-60 identity). The
 * version/tabline lives in the border itself (HUD title tab), the braille
 * dot-matrix Signal Chevron is the hero, and context is rendered as
 * labeled readout rows over a dashed rule + one tip.
 */
export function OccWelcome(props: OccWelcomeProps): React.ReactNode {
  const mode = getOccWelcomeMode(props.columns, props.plain)
  if (mode === 'plain') {
    return <PlainWelcome {...props} />
  }

  const [themeName] = useTheme()
  const cardWidth = Math.min(Math.max(props.columns, 1), WELCOME_MAX_WIDTH)
  const contentWidth = Math.max(cardWidth - 4, 1)
  const markMode: OccMarkMode = mode === 'wide' ? 'wide' : 'compact'
  const logo = getOccMark(markMode)
  const logoWidth = getOccMarkWidth(logo)
  const metaWidth =
    mode === 'wide' ? Math.max(contentWidth - logoWidth - 3, 1) : contentWidth
  const location = formatWelcomeLocation(props.branch, props.cwd, metaWidth)
  const animate = !props.reducedMotion

  const borderTitle = `${color('claude', themeName)('OCC')}${color(
    'inactive',
    themeName,
  )(` v${props.version} · Open C Code`)}`

  return (
    <Box
      width={cardWidth}
      flexDirection="column"
      borderStyle="round"
      borderColor="claude"
      borderText={{ content: borderTitle, position: 'top', align: 'start', offset: 2 }}
      paddingX={1}
    >
      {mode === 'wide' ? (
        <Box marginTop={1} flexDirection="row" gap={3} alignItems="center">
          <OccMark mode="wide" animate={animate} />
          <Metadata
            width={metaWidth}
            model={props.model}
            billing={props.billing}
            location={location}
            agentName={props.agentName}
          />
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column" alignItems="center">
          <OccMark mode="compact" animate={animate} />
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
      <Box marginTop={1} flexDirection="column">
        <DashedRule width={contentWidth} />
        <Box marginTop={0}>
          <Text dimColor wrap="truncate">
            {`▸ ${welcomeTip(mode, props.tip)}`}
          </Text>
        </Box>
      </Box>
      {props.children && <Box marginTop={1}>{props.children}</Box>}
    </Box>
  )
}
