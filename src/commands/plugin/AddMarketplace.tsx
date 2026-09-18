import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Byline } from '../../components/design-system/Byline.js';
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js';
import { Spinner } from '../../components/Spinner.js';
import TextInput from '../../components/TextInput.js';
import { Box, Text, useInput } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { toError } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js';
import { findMarketplaceNameForSource, formatSourceForDisplay } from '../../utils/plugins/marketplaceHelpers.js';
import { addMarketplaceSource, loadKnownMarketplacesConfigSafe, saveMarketplaceToSettings } from '../../utils/plugins/marketplaceManager.js';
import { parseMarketplaceInput } from '../../utils/plugins/parseMarketplaceInput.js';
import type { MarketplaceSource } from '../../utils/plugins/schemas.js';
import type { ConfirmAddMarketplace, ViewState } from './types.js';
type Props = {
  inputValue: string;
  setInputValue: (value: string) => void;
  cursorOffset: number;
  setCursorOffset: (offset: number) => void;
  error: string | null;
  setError: (error: string | null) => void;
  result: string | null;
  setResult: (result: string | null) => void;
  setViewState: (state: ViewState) => void;
  onAddComplete?: () => void | Promise<void>;
  cliMode?: boolean;
  /**
   * Official 2.1.275 (ws@223945393): when set, show the "Add marketplace?"
   * offer with y/n confirmation instead of adding immediately. `plugin` is the
   * pending `/plugin install <plugin> --marketplace <source>` target.
   */
  confirmAdd?: ConfirmAddMarketplace;
};

// Official `gp` (ws@223945393) — byte-exact.
const INVALID_SOURCE_FORMAT_ERROR = 'Invalid marketplace source format. Try: owner/repo, https://..., or ./path';

export function AddMarketplace({
  inputValue,
  setInputValue,
  cursorOffset,
  setCursorOffset,
  error,
  setError,
  result,
  setResult,
  setViewState,
  onAddComplete,
  cliMode = false,
  confirmAdd
}: Props): React.ReactNode {
  const hasAttemptedAutoAdd = useRef(false);
  // Official vt (ws@223945393): guards against double-confirming while adding.
  const addInProgress = useRef(false);
  // Official ae: set when the user cancels so a late async add never navigates.
  const navigatedAway = useRef(false);
  const [isLoading, setLoading] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string>('');
  // Official et: the parsed source shown in the confirmation prompt.
  const [resolvedSource, setResolvedSource] = useState<MarketplaceSource | null>(null);
  // Official Je.
  const targetPlugin = confirmAdd?.plugin;

  // Official Ot(de): add an already-parsed source, then navigate.
  const performAdd = async (parsed: MarketplaceSource) => {
    if (addInProgress.current) {
      return;
    }
    addInProgress.current = true;
    setError(null);
    try {
      setLoading(true);
      setProgressMessage('');
      const {
        name,
        resolvedSource: resolved
      } = await addMarketplaceSource(parsed, message => {
        setProgressMessage(message);
      });
      saveMarketplaceToSettings(name, {
        source: resolved
      });
      clearAllCaches();
      let sourceType = parsed.source;
      if (parsed.source === 'github') {
        sourceType = parsed.repo as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
      }
      logEvent('tengu_marketplace_added', {
        source_type: sourceType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
      if (onAddComplete) {
        await onAddComplete();
      }
      setProgressMessage('');
      setLoading(false);
      if (cliMode) {
        // In CLI mode, set result to trigger completion
        setResult(`Successfully added marketplace: ${name}`);
      } else if (!navigatedAway.current) {
        // Official: browse the new marketplace, keeping the pending plugin
        // (--marketplace offer) selected.
        setViewState({
          type: 'browse-marketplace',
          targetMarketplace: name,
          targetPlugin
        });
      }
    } catch (err) {
      // Allow a retry after a failed add (guards only in-flight double-adds).
      addInProgress.current = false;
      const error = toError(err);
      logError(error);
      setError(error.message);
      setProgressMessage('');
      setLoading(false);
      if (cliMode) {
        // In CLI mode, set result with error to trigger completion
        setResult(`Error: ${error.message}`);
      } else {
        setResult(null);
      }
    }
  };

  const handleAdd = async () => {
    const input = inputValue.trim();
    if (!input) {
      setError('Please enter a marketplace source');
      return;
    }
    const parsed = await parseMarketplaceInput(input);
    if (!parsed) {
      setError(INVALID_SOURCE_FORMAT_ERROR);
      return;
    }

    // Check if parseMarketplaceInput returned an error
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    await performAdd(parsed);
  };

  // Official Ze: cancel the offer and return to the menu.
  const handleCancel = () => {
    if (addInProgress.current) {
      return;
    }
    navigatedAway.current = true;
    setViewState({
      type: 'menu'
    });
  };

  // Auto-add if inputValue is provided (never in the confirmAdd offer flow —
  // official only auto-adds when the confirmation prop is absent).
  useEffect(() => {
    if (!confirmAdd && inputValue && !hasAttemptedAutoAdd.current && !error && !result) {
      hasAttemptedAutoAdd.current = true;
      void handleAdd();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, []); // Only run once on mount

  // Official je (ws@223945393): in confirm mode, resolve the source on mount.
  // Already-registered marketplaces (official M1r = findMarketplaceNameForSource)
  // skip the offer and go straight to browse with the pending plugin.
  useEffect(() => {
    if (!confirmAdd) {
      return;
    }
    let cancelled = false;
    const resolveSource = async () => {
      const parsed = await parseMarketplaceInput(inputValue.trim());
      if (cancelled) {
        return;
      }
      if (!parsed || 'error' in parsed) {
        setError(INVALID_SOURCE_FORMAT_ERROR);
        return;
      }
      const known = await loadKnownMarketplacesConfigSafe();
      if (cancelled) {
        return;
      }
      const existingName = findMarketplaceNameForSource(known, parsed);
      if (existingName !== undefined) {
        setViewState({
          type: 'browse-marketplace',
          targetMarketplace: existingName,
          targetPlugin: confirmAdd.plugin
        });
        return;
      }
      setResolvedSource(parsed);
    };
    void resolveSource();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, []); // Only run once on mount

  // Official keydown handler (lt): y/Y confirms (only once the source is
  // resolved), n/N cancels.
  // eslint-disable-next-line custom-rules/prefer-use-keybindings -- y/n confirmation not in keybinding schema
  useInput(input => {
    if (input === 'y' || input === 'Y') {
      if (resolvedSource) {
        void performAdd(resolvedSource);
      }
    } else if (input === 'n' || input === 'N') {
      handleCancel();
    }
  }, {
    isActive: confirmAdd !== undefined
  });

  // Official: confirm:no keybinding active when confirmAdd is set and not adding.
  useKeybinding('confirm:no', handleCancel, {
    context: 'Settings',
    isActive: confirmAdd !== undefined && !isLoading
  });

  if (confirmAdd) {
    const pinnedRef = resolvedSource && 'ref' in resolvedSource ? resolvedSource.ref : undefined;
    return <Box flexDirection="column">
        <Box flexDirection="column" paddingX={1} borderStyle="round">
          <Box marginBottom={1}>
            <Text bold>Add marketplace?</Text>
          </Box>
          {error && <Box marginTop={1}>
              <Text color="error">{error}</Text>
            </Box>}
          {!error && !resolvedSource && !isLoading && <Box marginTop={1}>
              <Spinner />
              <Text>Checking marketplace source…</Text>
            </Box>}
          {resolvedSource && !isLoading && <Box flexDirection="column" marginTop={1}>
              <Text>
                {targetPlugin !== undefined ? <>To install <Text bold>{targetPlugin}</Text>, add the marketplace that lists it:</> : 'Add this marketplace:'}
              </Text>
              <Text>{`  ${formatSourceForDisplay(resolvedSource)}`}</Text>
              {pinnedRef ? <Text>{`  Pinned to ${pinnedRef}; it won't receive updates past it.`}</Text> : null}
              <Text dimColor>
                {targetPlugin !== undefined ? "Only add marketplaces you trust. You'll review the plugin and choose where to install it next." : "Only add marketplaces you trust. You'll review its plugins before installing any."}
              </Text>
            </Box>}
          {isLoading && <Box marginTop={1}>
              <Spinner />
              <Text>
                {progressMessage || 'Adding marketplace to configuration…'}
              </Text>
            </Box>}
          {result && <Box marginTop={1}>
              <Text>{result}</Text>
            </Box>}
        </Box>
        {!isLoading && <Box marginLeft={3}>
            <Text dimColor italic>
              {resolvedSource ? <>Press <Text bold>y</Text> to add or <Text bold>n</Text> to cancel</> : <>Press <Text bold>n</Text> to cancel</>}
            </Text>
          </Box>}
      </Box>;
  }

  return <Box flexDirection="column">
      <Box flexDirection="column" paddingX={1} borderStyle="round">
        <Box marginBottom={1}>
          <Text bold>Add Marketplace</Text>
        </Box>
        <Box flexDirection="column">
          <Text>Enter marketplace source:</Text>
          <Text dimColor>Examples:</Text>
          <Text dimColor> · owner/repo (GitHub)</Text>
          <Text dimColor> · git@github.com:owner/repo.git (SSH)</Text>
          <Text dimColor> · https://example.com/marketplace.json</Text>
          <Text dimColor> · ./path/to/marketplace</Text>
          <Box marginTop={1}>
            <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleAdd} columns={80} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} focus showCursor />
          </Box>
        </Box>
        {isLoading && <Box marginTop={1}>
            <Spinner />
            <Text>
              {progressMessage || 'Adding marketplace to configuration…'}
            </Text>
          </Box>}
        {error && <Box marginTop={1}>
            <Text color="error">{error}</Text>
          </Box>}
        {result && <Box marginTop={1}>
            <Text>{result}</Text>
          </Box>}
      </Box>
      <Box marginLeft={3}>
        <Text dimColor italic>
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="add" />
            <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
          </Byline>
        </Text>
      </Box>
    </Box>;
}
