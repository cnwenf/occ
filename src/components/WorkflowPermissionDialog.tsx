/**
 * K3 (2.1.154): Pre-run consent dialog for dynamic workflows.
 *
 * Mirrors the 2.1.200 binary's `WorkflowPermissionDialog` (strings line
 * 473565). Before the Workflow tool launches a dynamic workflow that will
 * fan out across multiple phases/subagents, this dialog asks for explicit
 * consent — the standard permission prompt does not surface the phase
 * breakdown or script source, so a dedicated consent step is shown first.
 *
 * Binary render (verbatim strings):
 *   title:        "Run a dynamic workflow?"                  (line 562965)
 *   summary:      "This dynamic workflow will spin up multiple
 *                  subagents across the following phases:"   (line 562953)
 *   options:
 *     "Yes, run it"                          -> accept        (562944-45)
 *     "Yes, and don't ask again for …"       -> yes-always    (562946-47)
 *     "View workflow summary"               -> view-summary  (562948)
 *     "View raw script"                     -> view-raw      (562949)
 *   (Esc/reject cancels.)                    -> reject
 *
 * "View workflow summary" switches to a sub-view showing the workflow's
 * meta description + phases + args; "View raw script" shows the script
 * source. Both return to the option list on Esc/backspace, matching the
 * binary's non-terminal option behavior.
 *
 * This component is self-contained: WorkflowTool.checkPermissions (the
 * engine agent's file) imports it and renders it when a dynamic workflow
 * is about to run, threading onAccept/onAcceptAlways/onCancel into the
 * permission decision. OCC does not touch WorkflowTool.ts here.
 */
import * as React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { logEvent } from '../services/analytics/index.js'
import { toIDEDisplayName } from '../utils/ide.js'
import { editFileInEditor } from '../utils/promptEditor.js'
import { getExternalEditor } from '../utils/editor.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Select } from './CustomSelect/select.js'

/** Consent outcome — mirrors the binary's accept / yes-always / reject. */
export type WorkflowPermissionResult =
  | 'accept'
  | 'yes-always'
  | 'reject'

type SubView = 'options' | 'summary' | 'raw'

type Props = {
  /** Phase titles the workflow will fan out across (from meta.phases / phase() calls). */
  phases: string[]
  /** Estimated total agent count across all phases, if known. */
  estimatedAgents?: number
  /** Workflow meta.description — shown in the summary sub-view. */
  scriptSummary?: string
  /** Raw script source text — shown in the "View raw script" sub-view. */
  scriptSource?: string
  /** Path to the script file (shown in the summary sub-view). */
  scriptPath?: string
  /** Args passed to the workflow (shown in the summary sub-view). */
  args?: Record<string, unknown>
  /** "Yes, run it" — proceed with the workflow, asking again next time. */
  onAccept: () => void
  /** "Yes, and don't ask again for this workflow" — persist the grant. */
  onAcceptAlways: () => void
  /** Esc / reject — abort the workflow launch. */
  onCancel: () => void
}

type OptionValue = 'accept' | 'yes-always' | 'view-summary' | 'view-raw'

/**
 * Render the consent option list. The Select handles up/down/enter/esc;
 * selecting a non-terminal option (view-summary / view-raw) switches the
 * sub-view instead of resolving the dialog.
 */
function OptionsView({
  phases,
  estimatedAgents,
  onAccept,
  onAcceptAlways,
  onCancel,
  onViewSummary,
  onViewRaw,
}: {
  phases: string[]
  estimatedAgents?: number
  onAccept: () => void
  onAcceptAlways: () => void
  onCancel: () => void
  onViewSummary: () => void
  onViewRaw: () => void
}): React.ReactNode {
  const options = (
    [
      { label: 'Yes, run it', value: 'accept' as const },
      {
        label: 'Yes, and don’t ask again for this workflow',
        value: 'yes-always' as const,
      },
      { label: 'View workflow summary', value: 'view-summary' as const },
      { label: 'View raw script', value: 'view-raw' as const },
    ] satisfies ReadonlyArray<{ label: string; value: OptionValue }>
  )
  const handleChange = (value: OptionValue): void => {
    switch (value) {
      case 'accept':
        logEvent('tengu_workflow_permission_dialog_accept', {} as never)
        onAccept()
        break
      case 'yes-always':
        logEvent('tengu_workflow_permission_dialog_accept_always', {} as never)
        onAcceptAlways()
        break
      case 'view-summary':
        onViewSummary()
        break
      case 'view-raw':
        onViewRaw()
        break
    }
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text>
          This dynamic workflow will spin up multiple subagents across the
          following phases:
        </Text>
        <Box flexDirection="column" marginTop={0}>
          {phases.length > 0 ? (
            phases.map((p, i) => (
              <Text key={`${i}-${p}`} dimColor={true}>
                {'  • '}
                {p}
              </Text>
            ))
          ) : (
            <Text dimColor={true}>  (no phases declared)</Text>
          )}
        </Box>
        {typeof estimatedAgents === 'number' && estimatedAgents > 0 ? (
          <Text dimColor={true}>
            Estimated agents: {estimatedAgents}
          </Text>
        ) : null}
      </Box>
      <Select
        options={options}
        onChange={handleChange}
        onCancel={onCancel}
        visibleOptionCount={6}
      />
    </Box>
  )
}

/**
 * Render the workflow summary sub-view: meta description, script path,
 * phases, and args. Esc/backspace returns to the option list.
 */
function SummaryView({
  phases,
  estimatedAgents,
  scriptSummary,
  scriptPath,
  args,
  onBack,
}: {
  phases: string[]
  estimatedAgents?: number
  scriptSummary?: string
  scriptPath?: string
  args?: Record<string, unknown>
  onBack: () => void
}): React.ReactNode {
  useInput((_input, key) => {
    if (key.escape || key.backspace) {
      onBack()
    }
  })
  const argEntries = args ? Object.entries(args) : []
  return (
    <Box flexDirection="column" gap={1}>
      {scriptSummary ? (
        <Text>{scriptSummary}</Text>
      ) : (
        <Text dimColor={true}>(no description)</Text>
      )}
      {scriptPath ? <Text dimColor={true}>Script: {scriptPath}</Text> : null}
      <Box flexDirection="column">
        <Text bold={true}>Phases</Text>
        {phases.length > 0 ? (
          phases.map((p, i) => (
            <Text key={`s-${i}-${p}`} dimColor={true}>
              {'  • '}
              {p}
            </Text>
          ))
        ) : (
          <Text dimColor={true}>  (none)</Text>
        )}
      </Box>
      {typeof estimatedAgents === 'number' ? (
        <Text dimColor={true}>Estimated agents: {estimatedAgents}</Text>
      ) : null}
      {argEntries.length > 0 ? (
        <Box flexDirection="column">
          <Text bold={true}>args:</Text>
          {argEntries.map(([k, v]) => (
            <Text key={`arg-${k}`} dimColor={true}>
              {'  '}
              {k}: {typeof v === 'string' ? v : JSON.stringify(v)}
            </Text>
          ))}
        </Box>
      ) : null}
      <Byline>
        <KeyboardShortcutHint shortcut="Esc" action="back" />
      </Byline>
    </Box>
  )
}

/**
 * Render the raw script source sub-view. Esc/backspace returns to the
 * option list. The script is shown verbatim (truncated for terminal height
 * is handled by Ink wrapping); if the source is unavailable, a placeholder
 * is shown.
 */
function RawScriptView({
  scriptSource,
  scriptPath,
  onBack,
}: {
  scriptSource?: string
  scriptPath?: string
  onBack: () => void
}): React.ReactNode {
  useInput((_input, key) => {
    if (key.escape || key.backspace) {
      onBack()
    }
  })
  return (
    <Box flexDirection="column" gap={1}>
      {scriptPath ? (
        <Text dimColor={true}>{scriptPath}</Text>
      ) : null}
      {scriptSource ? (
        <Box flexDirection="column">
          {scriptSource.split('\n').map((line, i) => (
            <Text key={`ln-${i}`}>{line || ' '}</Text>
          ))}
        </Box>
      ) : (
        <Text dimColor={true}>
          Script source is not available in this view.
        </Text>
      )}
      <Byline>
        <KeyboardShortcutHint shortcut="Esc" action="back" />
      </Byline>
    </Box>
  )
}

export function WorkflowPermissionDialog(props: Props): React.ReactNode {
  const {
    phases,
    estimatedAgents,
    scriptSummary,
    scriptSource: scriptSourceProp,
    scriptPath,
    args,
    onAccept,
    onAcceptAlways,
    onCancel,
  } = props
  const [subView, setSubView] = React.useState<SubView>('options')
  // Track the live script source so the raw-script view updates after a
  // ctrl+g edit (the editor mutates the file on disk; we re-read it here).
  const [scriptSource, setScriptSource] = React.useState<string | undefined>(
    scriptSourceProp,
  )
  const [showSaveMessage, setShowSaveMessage] = React.useState(false)

  React.useEffect(() => {
    logEvent('tengu_workflow_permission_dialog_shown', {
      phase_count: phases.length,
      estimated_agents: estimatedAgents ?? 0,
    } as never)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-hide the "Script updated!" message after 5 seconds.
  React.useEffect(() => {
    if (showSaveMessage) {
      const timer = setTimeout(() => setShowSaveMessage(false), 5000)
      return () => clearTimeout(timer)
    }
  }, [showSaveMessage])

  const handleEditScript = React.useCallback(() => {
    if (!scriptPath) return
    logEvent('tengu_workflow_external_editor_used', {} as never)
    const result = editFileInEditor(scriptPath)
    if (result.error) {
      // Surface editor errors via the save-message slot — there is no
      // notification channel inside the consent dialog.
      return
    }
    if (result.content !== null && result.content !== scriptSource) {
      setScriptSource(result.content)
      setShowSaveMessage(true)
    }
  }, [scriptPath, scriptSource])

  // ctrl+g to edit the workflow script in $EDITOR — mirrors the official
  // binary's byline "ctrl+g to edit script in $EDITOR". Active in the
  // options and raw-script views (not summary, where no source is shown).
  useKeybinding('chat:externalEditor', handleEditScript, {
    context: 'Chat',
    isActive: !!scriptPath && subView !== 'summary',
  })

  const handleCancel = (): void => {
    logEvent('tengu_workflow_permission_dialog_reject', {} as never)
    onCancel()
  }

  let body: React.ReactNode
  if (subView === 'summary') {
    body = (
      <SummaryView
        phases={phases}
        estimatedAgents={estimatedAgents}
        scriptSummary={scriptSummary}
        scriptPath={scriptPath}
        args={args}
        onBack={() => setSubView('options')}
      />
    )
  } else if (subView === 'raw') {
    body = (
      <RawScriptView
        scriptSource={scriptSource}
        scriptPath={scriptPath}
        onBack={() => setSubView('options')}
      />
    )
  } else {
    body = (
      <OptionsView
        phases={phases}
        estimatedAgents={estimatedAgents}
        onAccept={onAccept}
        onAcceptAlways={onAcceptAlways}
        onCancel={handleCancel}
        onViewSummary={() => setSubView('summary')}
        onViewRaw={() => setSubView('raw')}
      />
    )
  }

  // When viewing summary/raw, Esc is handled inside the sub-view (to go back
  // to options); the Dialog's top-level onCancel must not also fire. We pass
  // a no-op cancel in those sub-views and let the sub-view own Esc.
  const dialogOnCancel = subView === 'options' ? handleCancel : () => {}

  // Resolve the editor display name once (module-level cache would be
  // ideal, but reading per-render is cheap and avoids stale state if
  // $EDITOR changes mid-session).
  const editor = getExternalEditor()
  const editorName = editor ? toIDEDisplayName(editor) : '$EDITOR'
  const showEditHint = !!scriptPath && subView !== 'summary'

  return (
    <Dialog
      title="Run a dynamic workflow?"
      color="warning"
      onCancel={dialogOnCancel}
      isCancelActive={subView === 'options'}
    >
      {body}
      {showEditHint ? (
        <Box flexDirection="row" gap={1} marginTop={1}>
          <ConfigurableShortcutHint
            action="chat:externalEditor"
            context="Chat"
            fallback="ctrl+g"
            description={`edit script in ${editorName}`}
          />
          {showSaveMessage ? (
            <>
              <Text dimColor={true}>{' · '}</Text>
              <Text color="green">{'✓ Script updated!'}</Text>
            </>
          ) : null}
        </Box>
      ) : null}
    </Dialog>
  )
}
