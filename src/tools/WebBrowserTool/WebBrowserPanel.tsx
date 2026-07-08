import React from 'react'
import { useAppState } from '../../state/AppState.js'
import { Box, Text } from '../../ink.js'

/**
 * Minimal WebBrowser panel. Renders the current browser URL (bagel pill) and
 * the last few captured console logs. OCC's browser is headless/local, so
 * there is no live remote-tab "view" to mirror — only the URL + logs surface.
 */
export function WebBrowserPanel(): React.ReactNode {
  const active = useAppState(s => s.bagelActive)
  const url = useAppState(s => s.bagelUrl)
  const logs = useAppState(s => s.webBrowserLogs)

  if (!active) return null

  return (
    <Box flexDirection="column" marginTop={0} borderStyle="round" borderColor="gray" paddingX={1}>
      <Box>
        <Text bold color="blue">🌐 WebBrowser</Text>
        <Text dimColor> {url ?? '(no page loaded)'}</Text>
      </Box>
      {logs && logs.length > 0 ? (
        <Box flexDirection="column">
          {logs.slice(-5).map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}
