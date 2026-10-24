import { relative } from 'path';
import React, { useMemo } from 'react';
import { useDiffInIDE } from '../../../hooks/useDiffInIDE.js';
import { Box, Text } from '../../../ink.js';
import type { ToolUseContext } from '../../../Tool.js';
import { getLanguageName } from '../../../utils/cliHighlight.js';
import { getCwd } from '../../../utils/cwd.js';
import { escapeControlCharsAsEntities } from '../../../utils/displayEscape.js';
import { getFsImplementation, resolveDeepestExistingAncestorSync, safeResolvePath } from '../../../utils/fsOperations.js';
import { expandPath } from '../../../utils/path.js';
import type { CompletionType } from '../../../utils/unaryLogging.js';
import { Select } from '../../CustomSelect/index.js';
import { ShowInIDEPrompt } from '../../ShowInIDEPrompt.js';
import { usePermissionRequestLogging } from '../hooks.js';
import { PermissionDialog } from '../PermissionDialog.js';
import type { ToolUseConfirm } from '../PermissionRequest.js';
import type { WorkerBadgeProps } from '../WorkerBadge.js';
import type { IDEDiffSupport } from './ideDiffConfig.js';
import type { FileOperationType, PermissionOption } from './permissionOptions.js';
import { type ToolInput, useFilePermissionDialog } from './useFilePermissionDialog.js';
export type FilePermissionDialogProps<T extends ToolInput = ToolInput> = {
  // Required props from PermissionRequestProps
  toolUseConfirm: ToolUseConfirm;
  toolUseContext: ToolUseContext;
  onDone: () => void;
  onReject: () => void;

  // Dialog customization
  title: string;
  subtitle?: React.ReactNode;
  question?: string | React.ReactNode;
  content?: React.ReactNode; // Can be general content or diff component

  // Logging
  completionType?: CompletionType;
  languageName?: string; // override — derived from path when omitted

  // File/directory operations
  path: string | null;
  parseInput: (input: unknown) => T;
  operationType?: FileOperationType;

  // IDE diff support
  ideDiffSupport?: IDEDiffSupport<T>;

  // Worker badge for teammate permission requests
  workerBadge: WorkerBadgeProps | undefined;
};
export function FilePermissionDialog<T extends ToolInput = ToolInput>({
  toolUseConfirm,
  toolUseContext,
  onDone,
  onReject,
  title,
  subtitle,
  question = 'Do you want to proceed?',
  content,
  completionType = 'tool_use_single',
  path,
  parseInput,
  operationType = 'write',
  ideDiffSupport,
  workerBadge,
  languageName: languageNameOverride
}: FilePermissionDialogProps<T>): React.ReactNode {
  // Derive from path unless caller provided an explicit override (NotebookEdit
  // passes 'python'/'markdown' from cell_type). getLanguageName is async;
  // downstream UnaryEvent.language_name and logPermissionEvent already accept
  // Promise<string>. useMemo keeps the promise stable across renders.
  const languageName = useMemo(() => languageNameOverride ?? (path ? getLanguageName(path) : 'none'), [languageNameOverride, path]);
  const unaryEvent = useMemo(() => ({
    completion_type: completionType,
    language_name: languageName
  }), [completionType, languageName]);
  usePermissionRequestLogging(toolUseConfirm, unaryEvent);
  // CC 2.1.310 item 5 (official resolver St @270881164 + landing pick Qjt
  // @243336917): reads resolve symlinks too — the 309 `if(r==="read"||n)
  // return null` read-skip is gone (BIN309=1 hit / BIN310=0). Official shape:
  //   St(e,r,n): remote → {target:null,unchecked:!1}; blockedPath!==void 0 →
  //   {target:n,unchecked:!1}; Ui(ut(e)).unresolved or throw →
  //   {target:null,unchecked:!0}; else {target:Qjt(s),unchecked:!1} where
  //   Qjt returns the landing ONLY when landing ≠ requested (a real symlink
  //   redirect), else null.
  // OCC mapping notes: (a) official's `r` (remoteWorkspace) flag has no OCC
  // counterpart (grep=0 in src/) — branch omitted; (b) safeResolvePath never
  // throws, so "unresolved" is reconstructed: realpath failed while the leaf
  // EXISTS (dangling link, ELOOP) → {target:null,unchecked:true}; an ABSENT
  // tail walks ancestors via resolveDeepestExistingAncestorSync and yields a
  // target only when the walk crossed a symlink (landing ≠ requested, Qjt) —
  // a new file under a plain directory stays {target:null,unchecked:false},
  // matching the official Ui walk; (c) special files (FIFO/socket/device)
  // keep safeResolvePath's guard semantics → {target:null,unchecked:false}.
  // expandPath throwing (null byte / non-string) hits the catch →
  // {target:null,unchecked:true}, mirroring official `catch{...!0}`.
  const blockedPath = toolUseConfirm.permissionResult != null && typeof toolUseConfirm.permissionResult === 'object' && 'blockedPath' in toolUseConfirm.permissionResult ? (toolUseConfirm.permissionResult as {
    blockedPath?: string;
  }).blockedPath : undefined;
  const symlinkInfo = useMemo(() => {
    if (blockedPath !== undefined) {
      return {
        target: blockedPath,
        unchecked: false
      };
    }
    if (!path) {
      return {
        target: null,
        unchecked: false
      };
    }
    try {
      const expandedPath = expandPath(path);
      const fs = getFsImplementation();
      const {
        resolvedPath,
        isSymlink,
        isCanonical
      } = safeResolvePath(fs, expandedPath);
      if (isCanonical) {
        // Qjt: target = landing only when it differs from the requested path.
        return {
          target: isSymlink ? resolvedPath : null,
          unchecked: false
        };
      }
      let leafStats = null;
      try {
        leafStats = fs.lstatSync(expandedPath);
      } catch {
        leafStats = null;
      }
      if (leafStats && !leafStats.isSymbolicLink() && !leafStats.isFile() && !leafStats.isDirectory()) {
        // FIFO/socket/device special — safeResolvePath guard, not a symlink case.
        return {
          target: null,
          unchecked: false
        };
      }
      if (leafStats) {
        // Leaf exists (incl. dangling symlink entry) but realpath failed:
        // ELOOP / dangling / EACCES-on-leaf → official `unresolved` → unchecked.
        return {
          target: null,
          unchecked: true
        };
      }
      // Absent tail: climb to the deepest existing ancestor (Ui's walk).
      const ancestorLanding = resolveDeepestExistingAncestorSync(fs, expandedPath);
      if (ancestorLanding !== undefined && relative(expandedPath, ancestorLanding) !== '') {
        return {
          target: ancestorLanding,
          unchecked: false
        };
      }
      return {
        target: null,
        unchecked: false
      };
    } catch {
      return {
        target: null,
        unchecked: true
      };
    }
  }, [path, blockedPath]);
  const fileDialogResult = useFilePermissionDialog({
    filePath: path || '',
    completionType,
    languageName,
    toolUseConfirm,
    onDone,
    onReject,
    parseInput,
    operationType
  });

  // Use file dialog results for options
  const {
    options,
    acceptFeedback,
    rejectFeedback,
    setFocusedOption,
    handleInputModeToggle,
    focusedOption,
    yesInputMode,
    noInputMode
  } = fileDialogResult;

  // Parse input using the provided parser
  const parsedInput = parseInput(toolUseConfirm.input);

  // Set up IDE diff support if enabled. Memoized: getConfig may do disk I/O
  // (FileWrite's getConfig calls readFileSync for the old-content diff).
  // Keyed on the raw input — parseInput is a pure Zod parse whose result
  // depends only on toolUseConfirm.input.
  const ideDiffConfig = useMemo(() => ideDiffSupport ? ideDiffSupport.getConfig(parseInput(toolUseConfirm.input)) : null, [ideDiffSupport, toolUseConfirm.input]);

  // Create diff params based on whether IDE diff is available
  const diffParams = ideDiffConfig ? {
    onChange: (option: PermissionOption, input: {
      file_path: string;
      edits: Array<{
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      }>;
    }) => {
      const transformedInput = ideDiffSupport!.applyChanges(parsedInput, input.edits);
      fileDialogResult.onChange(option, transformedInput);
    },
    toolUseContext,
    filePath: ideDiffConfig.filePath,
    edits: (ideDiffConfig.edits || []).map(e => ({
      old_string: e.old_string,
      new_string: e.new_string,
      replace_all: e.replace_all || false
    })),
    editMode: ideDiffConfig.editMode || 'single'
  } : {
    onChange: () => {},
    toolUseContext,
    filePath: '',
    edits: [],
    editMode: 'single' as const
  };
  const {
    closeTabInIDE,
    showingDiffInIDE,
    ideName
  } = useDiffInIDE(diffParams);
  const onChange = (option_0: PermissionOption, feedback?: string) => {
    closeTabInIDE?.();
    fileDialogResult.onChange(option_0, parsedInput, feedback?.trim());
  };
  if (showingDiffInIDE && ideDiffConfig && path) {
    // CC 2.1.310 item 5: descriptor emission uses the official field names —
    // `symlinkTarget: S.target` plus `...S.unchecked && {symlinkUnchecked:!0}`
    // (key present only when unchecked, BIN310 producer @270886868). The
    // official unified dialog renders the same verb-split warning in IDE-diff
    // mode (Xo is children[0] next to the showingDiffInIDE title swap), so
    // the split-out ShowInIDEPrompt gets operationType + symlinkUnchecked.
    return <ShowInIDEPrompt onChange={(option_1: PermissionOption, _input, feedback_0?: string) => onChange(option_1, feedback_0)} options={options} filePath={path} input={parsedInput} ideName={ideName} symlinkTarget={symlinkInfo.target} {...(symlinkInfo.unchecked ? {
      symlinkUnchecked: true
    } : {})} operationType={operationType} rejectFeedback={rejectFeedback} acceptFeedback={acceptFeedback} setFocusedOption={setFocusedOption} onInputModeToggle={handleInputModeToggle} focusedOption={focusedOption} yesInputMode={yesInputMode} noInputMode={noInputMode} />;
  }
  const symlinkTarget = symlinkInfo.target;
  const isSymlinkOutsideCwd = symlinkTarget != null && relative(getCwd(), symlinkTarget).startsWith('..');
  // CC 2.1.310 item 5 (official UI Xo @274085299): the verb follows the
  // operation type (`operationType==="read"?"read":"modify"`) and a new
  // `symlinkUnchecked` fallback branch renders the byte-verbatim literal
  // "Could not check where this path leads on disk" (310=2 hits / 309=0).
  // Security-review parity (OCC-132): target goes through the 2.1.291 G#9
  // control-char escaper, same as ShowInIDEPrompt — a locally-crafted symlink
  // whose target contains \n cannot spoof extra dialog lines. Identity for
  // ordinary paths (escapeControlCharsAsEntities ≡ official `ad`).
  const symlinkWarning = symlinkTarget ? <Box paddingX={1} marginBottom={1}>
      <Text color="warning">
        {isSymlinkOutsideCwd ? `This will ${operationType === 'read' ? 'read' : 'modify'} ${escapeControlCharsAsEntities(symlinkTarget)} (outside working directory) via a symlink` : `Symlink target: ${escapeControlCharsAsEntities(symlinkTarget)}`}
      </Text>
    </Box> : symlinkInfo.unchecked ? <Box paddingX={1} marginBottom={1}>
      <Text color="warning">Could not check where this path leads on disk</Text>
    </Box> : null;
  return <>
      <PermissionDialog title={title} subtitle={subtitle} innerPaddingX={0} workerBadge={workerBadge}>
        {symlinkWarning}
        {content}
        <Box flexDirection="column" paddingX={1}>
          {typeof question === 'string' ? <Text>{question}</Text> : question}
          <Select options={options} inlineDescriptions onChange={value => {
          const selected = options.find(opt => opt.value === value);
          if (selected) {
            // For reject option
            if (selected.option.type === 'reject') {
              const trimmedFeedback = rejectFeedback.trim();
              onChange(selected.option, trimmedFeedback || undefined);
              return;
            }
            // For accept-once option, pass accept feedback if present
            if (selected.option.type === 'accept-once') {
              const trimmedFeedback_0 = acceptFeedback.trim();
              onChange(selected.option, trimmedFeedback_0 || undefined);
              return;
            }
            onChange(selected.option);
          }
        }} onCancel={() => onChange({
          type: 'reject'
        })} onFocus={value_0 => setFocusedOption(value_0)} onInputModeToggle={handleInputModeToggle} />
        </Box>
      </PermissionDialog>
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>
          Esc to cancel
          {(focusedOption === 'yes' && !yesInputMode || focusedOption === 'no' && !noInputMode) && ' · Tab to amend'}
        </Text>
      </Box>
    </>;
}
