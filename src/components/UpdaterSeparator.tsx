import * as React from 'react';
import { Text } from '../ink.js';

/**
 * Official v299 (#049) status separator, shared by all three auto-updater
 * variants so the "Update installed" / update notice can render BESIDE other
 * status chrome (e.g. the idle "/clear to save tokens" hint) instead of on a
 * competing row.
 *
 * Byte-faithful to the decompiled inline expression
 * `T===void 0?null:e(n,{dimColor:!0,children:T?" \xB7":""})`
 * (n = Text): undefined → no node at all (legacy standalone render);
 * true → a leading dim " ·" divider; false → an empty dim Text (renders as a
 * gap-1 spacer with no glyph).
 */
export function UpdaterSeparator({
  withSeparator
}: {
  withSeparator?: boolean;
}): React.ReactNode {
  if (withSeparator === undefined) {
    return null;
  }
  return <Text dimColor>{withSeparator ? " \xB7" : ""}</Text>;
}
