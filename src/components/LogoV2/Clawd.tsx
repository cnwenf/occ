import * as React from 'react';
import { Box, Text } from '../../ink.js';

// OCC: the startup logo is a doge (replaces the Anthropic "Clawd" mascot).
// The pose prop is accepted for API compatibility with AnimatedClawd but
// ignored — the doge is static.
export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right';

type Props = {
  pose?: ClawdPose;
};

const DOGE_LINES = [
  '   /\\___/\\   ',
  '  (  o o  )  ',
  '  (  =w=  )  ',
  '   |_____|   ',
];

export function Clawd(_props: Props) {
  return (
    <Box flexDirection="column">
      {DOGE_LINES.map((line, i) => (
        <Text key={i} color="clawd_body">{line}</Text>
      ))}
    </Box>
  );
}
