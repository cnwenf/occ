/**
 * ct-01 fix — `/plugin` Errors-tab marketplace removal must NOT open the
 * y/n confirmation when the affected-plugin list could not be loaded.
 *
 * Before the fix `beginMarketplaceRemoval` wrapped `loadAllPlugins()` in an
 * empty catch: a load failure (corrupt plugin dir, permission denial) left
 * `pluginNames` at `[]`, the confirm dialog still opened and claimed zero
 * plugins would be uninstalled — while pressing 'y' removed the marketplace
 * by NAME and uninstalled however many plugins actually belonged to it.
 *
 * The fix splits the flow into two exported, testable pieces:
 *   - `prepareMarketplaceRemoval(action, loadPlugins)` — the loader is
 *     injectable; a rejecting loader yields `{status: 'blocked', message}`
 *     instead of a ready pending-removal;
 *   - `applyRemovalPreparation(prepared, setPendingRemoval, setActionMessage)`
 *     — a blocked preparation surfaces the error and NEVER sets
 *     pendingRemoval (so no dialog renders and the y/n keybinding stays
 *     disarmed).
 */
import { describe, expect, mock, test } from 'bun:test'
import type { PluginLoadResult } from '../../../types/plugin.js'
import {
  applyRemovalPreparation,
  prepareMarketplaceRemoval,
} from '../PluginSettings.js'

const action = {
  kind: 'remove-installed-marketplace',
  name: 'broken-market',
} as const

function plugin(name: string, source: string): never {
  return { name, source } as never
}

function loadResult(
  enabled: Array<[string, string]>,
  disabled: Array<[string, string]> = [],
): PluginLoadResult {
  return {
    enabled: enabled.map(([name, source]) => plugin(name, source)),
    disabled: disabled.map(([name, source]) => plugin(name, source)),
    errors: [],
  } as unknown as PluginLoadResult
}

describe('prepareMarketplaceRemoval (ct-01)', () => {
  test('a rejecting loadAllPlugins blocks the removal instead of yielding an empty list', async () => {
    // Arrange — the plugin dir is unreadable, loadAllPlugins rejects.
    const rejectingLoader = async (): Promise<PluginLoadResult> => {
      throw new Error('EACCES: permission denied, scandir plugins')
    }

    // Act
    const prepared = await prepareMarketplaceRemoval(action, rejectingLoader)

    // Assert — blocked, with the marketplace name and the load error surfaced,
    // and an explicit "affected count unknown / not started" disclosure.
    expect(prepared.status).toBe('blocked')
    if (prepared.status !== 'blocked') return
    expect(prepared.message).toContain('broken-market')
    expect(prepared.message).toContain('EACCES')
    expect(prepared.message).toContain('unknown')
    expect(prepared.message).toContain('not started')
  })

  test('a successful load gathers enabled AND disabled plugins of that marketplace only', async () => {
    const prepared = await prepareMarketplaceRemoval(action, async () =>
      loadResult(
        [
          ['alpha', 'alpha@broken-market'],
          ['beta', 'beta@other-market'],
        ],
        [['gamma', 'gamma@broken-market']],
      ),
    )

    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') return
    expect(prepared.pending.action).toBe(action)
    expect(prepared.pending.pluginNames).toEqual(['alpha', 'gamma'])
  })

  test('a successful load with zero matching plugins is ready with an empty list', async () => {
    const prepared = await prepareMarketplaceRemoval(action, async () =>
      loadResult([['beta', 'beta@other-market']]),
    )

    expect(prepared.status).toBe('ready')
    if (prepared.status !== 'ready') return
    expect(prepared.pending.pluginNames).toEqual([])
  })
})

describe('applyRemovalPreparation (ct-01)', () => {
  test('a blocked preparation surfaces the error and never sets pendingRemoval', () => {
    const setPendingRemoval = mock((_pending: unknown) => {})
    const setActionMessage = mock((_message: string) => {})

    applyRemovalPreparation(
      { status: 'blocked', message: 'Cannot remove "broken-market": …' },
      setPendingRemoval,
      setActionMessage,
    )

    expect(setPendingRemoval).not.toHaveBeenCalled()
    expect(setActionMessage).toHaveBeenCalledTimes(1)
    expect(setActionMessage.mock.calls[0]?.[0]).toContain('broken-market')
  })

  test('a ready preparation opens the confirm dialog and stays silent', () => {
    const setPendingRemoval = mock((_pending: unknown) => {})
    const setActionMessage = mock((_message: string) => {})
    const pending = { action, pluginNames: ['alpha'] }

    applyRemovalPreparation(
      { status: 'ready', pending },
      setPendingRemoval,
      setActionMessage,
    )

    expect(setPendingRemoval).toHaveBeenCalledTimes(1)
    expect(setPendingRemoval.mock.calls[0]?.[0]).toBe(pending)
    expect(setActionMessage).not.toHaveBeenCalled()
  })
})
