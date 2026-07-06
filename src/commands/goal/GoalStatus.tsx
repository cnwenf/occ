import { getTotalInputTokens } from '../../cost-tracker.js'
import * as React from 'react';
import { Box, Text, useInput } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import type { ActiveGoal } from '../../state/AppStateStore.js';

/**
 * 2.1.139 /goal status panel. Mirrors the official VZ4 component: shows the
 * active goal's condition, elapsed time, turn count, token count, and the
 * evaluator's last reason. Rendered by the /goal local-jsx command (no args).
 * Press escape/dismiss to close.
 */

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tokens`;
  return `${(n / 1_000_000).toFixed(1)}M tokens`;
}

export function GoalStatus({ onDone }: { onDone: () => void }) {
  const activeGoal = useAppState(s => s.activeGoal) as ActiveGoal | undefined;
  const lastAchieved = useAppState(s => s.lastAchievedGoal);
  // Tick every second so the running duration updates live.
  const [, setTick] = React.useReducer(n => n + 1, 0);
  React.useEffect(() => {
    const i = setInterval(setTick, 1000);
    return () => clearInterval(i);
  }, []);
  useInput((input, key) => {
    if (key.escape) onDone();
  });

  // D8: Goal-achieved panel state (mirrors official VZ4 achieved branch).
  if (!activeGoal && lastAchieved) {
    const turns = lastAchieved.iterations > 0 ? `${lastAchieved.iterations} turn${lastAchieved.iterations === 1 ? '' : 's'}` : null;
    const subtitle = [formatDuration(lastAchieved.durationMs), turns, lastAchieved.tokens != null ? formatTokens(lastAchieved.tokens) : null].filter(Boolean).join(' · ');
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} minWidth={40}>
        <Text bold color="green">Goal achieved</Text>
        {subtitle ? <Text dimColor>{subtitle}</Text> : null}
        <Box flexDirection="row">
          <Text dimColor>Goal: </Text>
          <Text wrap="wrap">{lastAchieved.condition}</Text>
        </Box>
        <Text dimColor>/goal &lt;condition&gt; to set another</Text>
      </Box>
    );
  }

  if (!activeGoal) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Text bold color="claude">Goal</Text>
        <Text>No goal set</Text>
        <Text dimColor>/goal &lt;condition&gt; to set one</Text>
      </Box>
    );
  }

  // D8: Goal-could-not-be-achieved failure state. Mirrors official
  // `i = n.failed === true` → "Goal could not be achieved" (error/red), with the
  // evaluator's stopReason as "Reason:". Triggered when the goal Stop-hook
  // evaluator returns `impossible: true` (see execPromptHook + stopHooks.ts).
  if (activeGoal.failed) {
    const elapsed = Date.now() - activeGoal.setAt;
    const turns = activeGoal.iterations > 0 ? `${activeGoal.iterations} turn${activeGoal.iterations === 1 ? '' : 's'}` : null;
    const subtitle = [formatDuration(elapsed), turns].filter(Boolean).join(' · ');
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} minWidth={40}>
        <Text bold color="red">Goal could not be achieved</Text>
        {subtitle ? <Text dimColor>{subtitle}</Text> : null}
        <Box flexDirection="row" marginTop={0}>
          <Text dimColor>Goal: </Text>
          <Text wrap="wrap">{activeGoal.condition}</Text>
        </Box>
        {activeGoal.failureReason ? (
          <Box flexDirection="row">
            <Text dimColor>Reason: </Text>
            <Text wrap="wrap">{activeGoal.failureReason.trim()}</Text>
          </Box>
        ) : null}
        <Text dimColor>/goal &lt;condition&gt; to try again</Text>
      </Box>
    );
  }

  const elapsed = Date.now() - activeGoal.setAt;
  const turns = activeGoal.iterations > 0 ? `${activeGoal.iterations} turn${activeGoal.iterations === 1 ? '' : 's'}` : null;
  // Token delta since the goal was set (official: gS() - tokensAtStart).
  const tokenDelta = Math.max(0, getTotalInputTokens() - (activeGoal.tokensAtStart ?? 0));
  const subtitle = [`running ${formatDuration(elapsed)}`, turns, formatTokens(tokenDelta)].filter(Boolean).join(' · ');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} minWidth={40}>
      <Text bold color="claude"> Goal active</Text>
      <Text dimColor>{subtitle}</Text>
      <Box flexDirection="row" marginTop={0}>
        <Text dimColor>Goal: </Text>
        <Text wrap="wrap">{activeGoal.condition}</Text>
      </Box>
      {activeGoal.lastReason ? (
        <Box flexDirection="row">
          <Text dimColor>Last check: </Text>
          <Text wrap="wrap">{activeGoal.lastReason.trim()}</Text>
        </Box>
      ) : null}
      <Text dimColor>/goal clear to stop early</Text>
    </Box>
  );
}
