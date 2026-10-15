import React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { Text } from '../../ink.js';
import { truncate } from '../../utils/format.js';
import type { CreateOutput } from './CronCreateTool.js';
import type { DeleteOutput } from './CronDeleteTool.js';
import type { ListOutput } from './CronListTool.js';
import { nextRunUiSuffix } from './nextRunDisplay.js';

// --- CronCreate -------------------------------------------------------------

export function renderCreateToolUseMessage(input: Partial<{
  cron: string;
  prompt: string;
}>): React.ReactNode {
  return `${input.cron ?? ''}${input.prompt ? `: ${truncate(input.prompt, 60, true)}` : ''}`;
}
// Official 2.1.299 (#074) `Jh` (v299 @243490000): dim segment is
// `("(", humanSchedule, oT(nextFireAt), ")")` — the next-run suffix joins
// the human schedule inside the parens.
export function renderCreateResultMessage(output: CreateOutput): React.ReactNode {
  return <MessageResponse>
      <Text>
        Scheduled <Text bold>{output.id}</Text>{' '}
        <Text dimColor>({output.humanSchedule}{nextRunUiSuffix(output.nextFireAt)})</Text>
      </Text>
    </MessageResponse>;
}

// --- CronDelete -------------------------------------------------------------

export function renderDeleteToolUseMessage(input: Partial<{
  id: string;
}>): React.ReactNode {
  return input.id ?? '';
}
export function renderDeleteResultMessage(output: DeleteOutput): React.ReactNode {
  return <MessageResponse>
      <Text>
        Cancelled <Text bold>{output.id}</Text>
      </Text>
    </MessageResponse>;
}

// --- CronList ---------------------------------------------------------------

export function renderListToolUseMessage(): React.ReactNode {
  return '';
}
export function renderListResultMessage(output: ListOutput): React.ReactNode {
  if (output.jobs.length === 0) {
    return <MessageResponse>
        <Text dimColor>No scheduled jobs</Text>
      </MessageResponse>;
  }
  // Official 2.1.299 (#074) `eT` (v299 @243490400): each row appends
  // `oT(nextFireAt)` after the schedule metadata.
  return <MessageResponse>
      {output.jobs.map(j => <Text key={j.id}>
          <Text bold>{j.id}</Text> <Text dimColor>{j.humanSchedule}{nextRunUiSuffix(j.nextFireAt)}</Text>
        </Text>)}
    </MessageResponse>;
}

// --- Shared -----------------------------------------------------------------
