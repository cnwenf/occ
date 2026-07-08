import * as React from 'react';
import { Box, Text, useAnimationFrame } from '../../ink.js';
import { getDefaultCharacters } from './utils.js';

const DEFAULT_CHARACTERS = getDefaultCharacters();
// Forward + reverse for a smooth bounce, matching SpinnerGlyph's frame cycle.
const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];
const FRAME_MS = 120;

type Props = {
  reducedMotion?: boolean;
};

/**
 * Inline animated "Thinking…" spinner shown in the message row while the
 * model emits thinking blocks. Unlike the status-bar thinking indicator
 * (SpinnerAnimationRow), this renders inline with the streaming thinking
 * content so the user sees live thinking activity in the transcript itself.
 *
 * Owns its own useAnimationFrame(120) subscription — mounted only while
 * thinking is streaming (see AssistantThinkingMessage `isStreaming`), so it
 * does not add a clock subscriber to completed thinking blocks. The clock
 * pauses when the element scrolls offscreen or the terminal is blurred.
 */
export function InlineThinkingSpinner({ reducedMotion = false }: Props): React.ReactNode {
  const [viewportRef, time] = useAnimationFrame(reducedMotion ? null : FRAME_MS);
  const frame = reducedMotion ? 0 : Math.floor(time / FRAME_MS);
  const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
  return (
    <Box ref={viewportRef} flexDirection="row">
      <Text color="text">{glyph}</Text>
      <Text> </Text>
      <Text dimColor italic>Thinking…</Text>
    </Box>
  );
}
