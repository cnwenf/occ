import { useEffect, useState } from 'react';
import { Box, Text } from '../../ink.js';
import { THINKING_HINTS } from './thinkingHints.js';

/**
 * claude-code 2.1.109: a rotating progress hint shown beneath the "Thinking"
 * indicator during extended thinking. Mirrors v109's `dgK` component: when
 * active, schedule a setTimeout per hint at its `afterMs`; each timer advances
 * the index, so the hint rotates as time passes.
 */
export function ThinkingHintLine({ active }: { active: boolean }): React.ReactNode {
  const [index, setIndex] = useState(-1);
  useEffect(() => {
    if (!active) {
      if (index !== -1) {
        setIndex(-1);
      }
      return;
    }
    // Schedule a timer per hint; each sets the index to that hint's position.
    const timers = THINKING_HINTS.map((hint, i) =>
      setTimeout(setIndex, hint.afterMs, i),
    );
    return () => {
      for (const t of timers) {
        clearTimeout(t);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (!active || index < 0) {
    return null;
  }
  return (
    <Box>
      <Text dimColor>{THINKING_HINTS[index]?.text}</Text>
    </Box>
  );
}
