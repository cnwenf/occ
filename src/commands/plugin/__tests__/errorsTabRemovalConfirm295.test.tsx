/**
 * CC 2.1.295 port — `/plugin` Errors tab marketplace-removal confirmation.
 *
 * Official changelog: "Fixed `/plugin`'s Errors tab removing a marketplace
 * that failed to load, and uninstalling its plugins, on Enter without asking
 * first". The Errors tab now asks via the official dialog (binary evidence
 * s295@2750572) before running the removal. These tests render the extracted
 * `MarketplaceRemovalConfirm` component through the real Ink reconciler
 * (PassThrough harness, same pattern as validatePluginTui289.test.tsx) and
 * assert the emitted frame carries the official texts.
 */
import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { render } from '../../../ink.js'
import { MarketplaceRemovalConfirm } from '../PluginSettings.js'

async function renderConfirm(
  name: string,
  pluginNames: string[],
): Promise<string> {
  let output = ''
  const stream = new PassThrough()
  stream.on('data', chunk => {
    output += chunk.toString()
  })
  const instance = await render(
    <MarketplaceRemovalConfirm name={name} pluginNames={pluginNames} />,
    { stdout: stream as unknown as NodeJS.WriteStream, patchConsole: false },
  )
  try {
    await new Promise(resolve => setTimeout(resolve, 200))
  } finally {
    instance.unmount()
  }
  return stripAnsi(output)
}

describe('MarketplaceRemovalConfirm (official 2.1.295 Errors-tab confirm dialog)', () => {
  test('renders the official title with the marketplace name', async () => {
    const text = await renderConfirm('broken-market', [])
    expect(text).toContain('Remove marketplace broken-market?')
  })

  test('renders the official y/n footer', async () => {
    const text = await renderConfirm('broken-market', [])
    expect(text.replace(/\s+/g, ' ')).toContain(
      'Press y to confirm or n to cancel',
    )
  })

  test('lists the plugins that will be uninstalled, with singular plural()', async () => {
    const text = await renderConfirm('broken-market', ['only-plugin'])
    const flat = text.replace(/\s+/g, ' ')
    expect(flat).toContain(
      'This will also uninstall 1 plugin from this marketplace:',
    )
    expect(text).toContain('• only-plugin')
  })

  test('uses the plural form for multiple plugins', async () => {
    const text = await renderConfirm('broken-market', ['alpha', 'beta'])
    const flat = text.replace(/\s+/g, ' ')
    expect(flat).toContain(
      'This will also uninstall 2 plugins from this marketplace:',
    )
    expect(text).toContain('• alpha')
    expect(text).toContain('• beta')
  })

  test('omits the uninstall row entirely when no plugin would be uninstalled', async () => {
    const text = await renderConfirm('broken-market', [])
    expect(text).not.toContain('This will also uninstall')
  })
})
