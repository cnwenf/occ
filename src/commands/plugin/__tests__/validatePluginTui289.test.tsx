// OCC-107 acceptance-fix ③ (2026-10-05) — behavioral regression for the
// `/plugin validate` TUI path (src/commands/plugin/ValidatePlugin.tsx).
//
// The help text has always advertised folder co-location validation
// ("automatically validates .claude-plugin/marketplace.json or
// .claude-plugin/plugin.json (both, and the plugin, if both exist)"), but the
// TUI's runValidation only ever called validateManifest(path) — the CLI
// handler (src/cli/handlers/plugins.ts) was the only surface composing the
// co-located plugin.json / content results. Result: the TUI printed
// "✔ Validation passed" for a folder whose co-located plugin.json was
// truncated JSON — a FAKE SUCCESS the CLI path never had.
//
// The fix routes both surfaces through the shared
// collectContentValidationResults() helper; this test renders the real
// component through Ink (PassThrough harness, same pattern as
// statusNoticesContainer278.test.tsx) and asserts on the onComplete output
// string the REPL prints.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as React from 'react'
import { render } from '../../../ink.js'
import { ValidatePlugin } from '../ValidatePlugin.js'

const CLEAN_PLUGIN = {
  name: 'demo-plugin',
  version: '1.0.0',
  description: 'demo plugin for the OCC-107 TUI validation tests',
  author: { name: 'occ-test' },
}

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.all(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

async function writeMarketplace(
  root: string,
  plugins: unknown[],
): Promise<void> {
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      {
        name: 'occ-test-market',
        owner: { name: 'occ-test' },
        plugins,
        metadata: { description: 'test marketplace' },
      },
      null,
      2,
    ),
  )
}

async function writePluginJson(root: string, content: string): Promise<void> {
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), content)
}

/**
 * Render <ValidatePlugin path onComplete> in the real Ink reconciler and
 * resolve with the output string the component hands to onComplete.
 * process.exitCode is saved/restored (the component sets it — leaking 1 into
 * the bun test process would fail the whole run).
 */
async function runTuiValidation(path: string | undefined): Promise<string> {
  const prevExitCode = process.exitCode
  const stream = new PassThrough()
  let resolveOutput: (value: string) => void = () => {}
  let rejectOutput: (reason: Error) => void = () => {}
  const outputPromise = new Promise<string>((resolve, reject) => {
    resolveOutput = resolve
    rejectOutput = reject
  })
  const timeout = setTimeout(
    () => rejectOutput(new Error('ValidatePlugin never called onComplete')),
    15000,
  )
  const instance = await render(
    <ValidatePlugin
      path={path}
      onComplete={result => resolveOutput(result ?? '')}
    />,
    { stdout: stream as unknown as NodeJS.WriteStream, patchConsole: false },
  )
  try {
    return await outputPromise
  } finally {
    clearTimeout(timeout)
    instance.unmount()
    process.exitCode = prevExitCode
  }
}

describe('OCC-107 acceptance-fix ③ — /plugin validate TUI reports co-located plugin + contents (no fake success)', () => {
  test('INVALID co-located plugin.json → TUI output includes the plugin section and FAILS (was: marketplace-only "Validation passed")', async () => {
    // Arrange — valid marketplace, truncated plugin.json, one content file
    const root = await makeTempRoot('occ107-tui-fail-')
    await writeMarketplace(root, [{ name: 'demo-plugin', source: './' }])
    await writePluginJson(root, '{ truncated plugin.json')
    await mkdir(join(root, 'commands'), { recursive: true })
    await writeFile(join(root, 'commands', 'hello.md'), 'Say hello.')

    // Act
    const output = await runTuiValidation(root)

    // Assert — every validated file gets its own section, and the overall
    // verdict reflects the invalid co-located plugin.json.
    expect(output).toContain('Validating marketplace manifest:')
    expect(output).toContain('Validating plugin:')
    expect(output).toContain('Validating command:')
    expect(output).toContain('Validation failed')
    expect(output).not.toContain('Validation passed')
  })

  test('CLEAN co-located plugin.json + content warnings → command section spliced in, overall verdict "passed with warnings"', async () => {
    // Arrange — f-gate drops the clean pluginResult; the bare command file
    // (no frontmatter) contributes warnings.
    const root = await makeTempRoot('occ107-tui-warn-')
    await writeMarketplace(root, [{ name: 'demo-plugin', source: './' }])
    await writePluginJson(root, JSON.stringify(CLEAN_PLUGIN))
    await mkdir(join(root, 'commands'), { recursive: true })
    await writeFile(join(root, 'commands', 'hello.md'), 'Say hello.')

    // Act
    const output = await runTuiValidation(root)

    // Assert
    expect(output).toContain('Validating marketplace manifest:')
    expect(output).not.toContain('Validating plugin:') // f-gate: no findings
    expect(output).toContain('Validating command:')
    expect(output).toContain('Validation passed with warnings')
  })
})
