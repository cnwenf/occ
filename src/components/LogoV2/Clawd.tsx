import * as React from 'react';
import { Box, Text } from '../../ink.js';

// OCC: the startup logo is a doge (replaces the Anthropic "Clawd" mascot).
// Two-tone shading (body in the brand clawd_body orange, eyes/snout in the
// lighter claudeShimmer, tail dimmed) gives the mascot depth without leaving
// the terminal-safe ASCII glyph set — legacy terminals render every line.
// The pose prop is accepted for API compatibility with AnimatedClawd but
// ignored — the doge is static.
export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right';

type Props = {
  pose?: ClawdPose;
};

// Each art line, in render order. Widths are normalized at render time so the
// mascot always sits in a clean rectangle (no jagged right edge when the tail
// or paws differ in length).
const BODY_LINES = [
  '   /\\___/\\   ',
  '  ( o w o )~~',
  '  (  =w=  )  ',
  '   \\_____/   ',
  '    | | |    ',
];

// Characters rendered in the lighter accent shade (eyes, snout, tail).
const ACCENT_CHARS = new Set(['o', 'w', '=', '~']);

// Pad every art line to the width of the longest, so the mascot is a rectangle.
function normalizeLines(lines: string[]): string[] {
  const max = lines.reduce((m, l) => Math.max(m, l.length), 0);
  return lines.map((l) => l.padEnd(max));
}

const DOGE_LINES = normalizeLines(BODY_LINES);

// Split a single art line into runs of accent vs body characters so each run
// can be colored independently. Whitespace is emitted as plain text (no color).
function renderLine(line: string, lineKey: number) {
  const segments: React.ReactNode[] = [];
  let buffer = '';
  let accent = false;
  const flush = (until: number) => {
    if (buffer.length === 0) return;
    segments.push(
      accent ? (
        <Text key={`${lineKey}-${until}-a`} color="claudeShimmer">
          {buffer}
        </Text>
      ) : (
        <Text key={`${lineKey}-${until}-b`} color="clawd_body">
          {buffer}
        </Text>
      ),
    );
    buffer = '';
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === ' ' || ch === '\t') {
      flush(i);
      segments.push(<Text key={`${lineKey}-sp-${i}`}> </Text>);
      continue;
    }
    const isAccent = ACCENT_CHARS.has(ch);
    if (buffer.length === 0 || isAccent === accent) {
      buffer += ch;
      accent = isAccent;
    } else {
      flush(i);
      buffer = ch;
      accent = isAccent;
    }
  }
  flush(line.length);
  return <Text key={lineKey}>{segments}</Text>;
}

export function Clawd(_props: Props) {
  return (
    <Box flexDirection="column">
      {DOGE_LINES.map((line, i) => renderLine(line, i))}
    </Box>
  );
}
