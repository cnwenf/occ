import * as React from 'react';
import { Box, Text } from '../../ink.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';

// 2.1.144: /extra-usage was renamed to /usage-credits. This stub delegates to
// the real /usage-credits command and surfaces a rename notice, mirroring the
// official Kkf interactive stub.
const RENAME_NOTICE = '/extra-usage is now /usage-credits';

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode | null> {
  const { call: realCall } = await import('../usage-credits/usage-credits.js');
  const result = await realCall(
    (s, opts) => onDone(s ? `${RENAME_NOTICE}\n${s}` : RENAME_NOTICE, opts),
    context,
  );
  if (result == null) return result;
  return (
    <Box flexDirection="column">
      <Text dimColor>{RENAME_NOTICE}</Text>
      {result}
    </Box>
  );
}
