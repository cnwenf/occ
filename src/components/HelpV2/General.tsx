import * as React from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import { PromptInputHelpMenu } from '../PromptInput/PromptInputHelpMenu.js';

// 2.1.251 (OCC-110): byte-verified against the official binary's /help
// General tab component — `rows < 44` gates the "New here? Run /powerup ..."
// line and collapses paddingY/gap to 0 on compact terminals. The powerup
// command renders in the theme's `suggestion` color. The OCC-109 baseline
// removed the stale memo-cache here; this component is now plain (no `_c`).
const COMPACT_ROW_THRESHOLD = 44;

export function General() {
  const { rows } = useTerminalSize();
  const isCompact = rows < COMPACT_ROW_THRESHOLD;
  const spacing = isCompact ? 0 : 1;
  return (
    <Box flexDirection="column" paddingY={spacing} gap={spacing}>
      <Box flexShrink={0}>
        <Text>
          Claude understands your codebase, makes edits with your permission,
          and executes commands — right from your terminal.
        </Text>
      </Box>
      {!isCompact && (
        <Box>
          <Text dimColor>
            New here? Run <Text color="suggestion">/powerup</Text> to learn the
            features most people miss.
          </Text>
        </Box>
      )}
      <Box flexDirection="column">
        <Box>
          <Text bold>Shortcuts</Text>
        </Box>
        <PromptInputHelpMenu gap={2} fixedWidth />
      </Box>
    </Box>
  );
}
