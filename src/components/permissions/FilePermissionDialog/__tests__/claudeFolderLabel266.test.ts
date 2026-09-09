import { describe, expect, test } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { getEmptyToolPermissionContext } from '../../../../Tool.js';
import { getOriginalCwd } from '../../../../bootstrap/state.js';
import { getFilePermissionOptions } from '../permissionOptions.js';

/**
 * OCC-81 alignment with official claude-code 2.1.266 — the `.claude` folder
 * permission option label. Byte-level forensics on the official linux-x64 ELF
 * (function `rBo`, renderLabel region) recovered the option verbatim:
 *
 *   function rBo(w,P,ee){let ce=eBo(w),ge=tBo(w);if((ce||ge)&&P!=="read"){
 *     let Xe=ge?gRt:mRt, ...
 *     return ge
 *       ? "Yes, and allow Claude to edit files in its ~/.claude folder for this session"
 *       : "Yes, and allow Claude to edit files in this project's .claude folder for this session"
 *   }});
 *   return st===null?null:{row:st,value:"yes-claude-folder"}
 *
 * where ge = global-folder detector (tBo), ce = project-folder detector (eBo),
 * and the paired rule patterns are gRt="~/.claude/**" / mRt="/.claude/**".
 *
 * Official 2.1.263 shipped a single static label:
 *   "Yes, and allow Claude to edit its own settings for this session"
 * String counts across binaries: old label 263=2 / 266=0; new labels 263=0 /
 * 266=3; `value:"yes-claude-folder"` identical in both. OCC carried the 263
 * static label — this test drives the real getFilePermissionOptions() and
 * pins the official 266 two-branch labels + read-op gate.
 */

const OFFICIAL_PROJECT_LABEL =
  "Yes, and allow Claude to edit files in this project's .claude folder for this session";
const OFFICIAL_GLOBAL_LABEL =
  'Yes, and allow Claude to edit files in its ~/.claude folder for this session';
const STALE_263_LABEL =
  'Yes, and allow Claude to edit its own settings for this session';

function claudeFolderOption(filePath: string, operationType: 'read' | 'write' | 'create' = 'write') {
  const options = getFilePermissionOptions({
    filePath,
    toolPermissionContext: getEmptyToolPermissionContext(),
    operationType,
  });
  return options.find(o => o.value === 'yes-claude-folder');
}

describe('OCC-81: .claude folder permission option matches official 2.1.266', () => {
  test("project .claude write shows the official project-folder label with scope 'claude-folder'", () => {
    const filePath = join(getOriginalCwd(), '.claude', 'settings.json');
    const option = claudeFolderOption(filePath, 'write');
    expect(option).toBeDefined();
    expect(option?.label).toBe(OFFICIAL_PROJECT_LABEL);
    expect(option?.option).toEqual({ type: 'accept-session', scope: 'claude-folder' });
  });

  test("global ~/.claude write shows the official global-folder label with scope 'global-claude-folder'", () => {
    const filePath = join(homedir(), '.claude', 'settings.json');
    const option = claudeFolderOption(filePath, 'write');
    expect(option).toBeDefined();
    expect(option?.label).toBe(OFFICIAL_GLOBAL_LABEL);
    expect(option?.option).toEqual({ type: 'accept-session', scope: 'global-claude-folder' });
  });

  test('create operation also gets the .claude-folder option (gate is only on read)', () => {
    const filePath = join(getOriginalCwd(), '.claude', 'commands', 'new.md');
    const option = claudeFolderOption(filePath, 'create');
    expect(option).toBeDefined();
    expect(option?.label).toBe(OFFICIAL_PROJECT_LABEL);
  });

  test('read operation never shows the .claude-folder option (official `P!=="read"` gate)', () => {
    const projectPath = join(getOriginalCwd(), '.claude', 'settings.json');
    const globalPath = join(homedir(), '.claude', 'settings.json');
    expect(claudeFolderOption(projectPath, 'read')).toBeUndefined();
    expect(claudeFolderOption(globalPath, 'read')).toBeUndefined();
  });

  test('stale 2.1.263 label must never be returned from any option', () => {
    const filePaths = [
      join(getOriginalCwd(), '.claude', 'settings.json'),
      join(homedir(), '.claude', 'settings.json'),
      join(getOriginalCwd(), 'src', 'index.ts'),
    ];
    for (const filePath of filePaths) {
      for (const operationType of ['read', 'write', 'create'] as const) {
        const options = getFilePermissionOptions({
          filePath,
          toolPermissionContext: getEmptyToolPermissionContext(),
          operationType,
        });
        for (const option of options) {
          if (typeof option.label === 'string') {
            expect(option.label).not.toContain(STALE_263_LABEL);
          }
        }
      }
    }
  });
});
