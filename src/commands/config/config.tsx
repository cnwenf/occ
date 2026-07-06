import * as React from 'react';
import { Settings } from '../../components/Settings/Settings.js';
import { COMMON_HELP_ARGS } from '../../constants/xml.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { buildConfigKeyList } from './config-noninteractive.js';

// E24 (2.1.183): /config --help lists the shorthand config keys inline
// instead of opening the settings panel. Mirrors the official 2.1.200
// binary: `Run /config to open settings, or /config key=value to set one
// directly. <key list>`.
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const arg = args?.trim().toLowerCase();
  if (arg && COMMON_HELP_ARGS.includes(arg)) {
    onDone(`Run /config to open settings, or /config key=value to set one directly.\n${buildConfigKeyList()}`, {
      display: 'system',
    });
    return null;
  }
  return <Settings onClose={onDone} context={context} defaultTab="Config" />;
};
