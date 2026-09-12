import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ValidationError,
  validateManifest,
  validateMarketplaceManifest,
  validatePluginManifest,
} from '../validatePlugin.js'

/**
 * CC 2.1.268 (E35): `claude plugin validate` no longer refuses paths whose
 * directory NAME begins with two dots. Official 268 changelog (byte-verified
 * in added.txt): "Fixed plugin directories whose names begin with two dots
 * being wrongly refused as outside the plugin root". The official binary's
 * traversal predicates are separator-aware (`d === ".." || d.startsWith(".."
 * + sep)`) or segment-wise (`split("/").some(s => s === "..")`) — never a raw
 * `includes("..")` substring match. OCC's checkPathTraversal now mirrors the
 * segment-wise shape (splitting on both / and \ so Windows-style paths keep
 * the coverage the old substring check had).
 *
 * Loader agreement: OCC's install-time containment choke point
 * (validatePathWithinBase, pluginInstallationHelpers.ts) resolves lexically,
 * so a `..name` directory stays inside the base and loads fine — validate and
 * loader now agree.
 */

const TRAVERSAL_MESSAGE = /Path contains "\.\."/

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.allSettled(
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
): Promise<string> {
  const manifestPath = join(root, '.claude-plugin', 'marketplace.json')
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeFile(
    manifestPath,
    JSON.stringify({
      name: 'dotdot-market',
      owner: { name: 'occ-test' },
      plugins,
    }),
  )
  return manifestPath
}

function traversalErrors(errors: ValidationError[]): ValidationError[] {
  return errors.filter(e => TRAVERSAL_MESSAGE.test(e.message))
}

describe('2.1.268: plugin validate accepts dot-dot-prefixed names (E35)', () => {
  test('plugin directory named "..myplugin" validates end-to-end', async () => {
    // Arrange — a marketplace whose plugin lives in a directory whose name
    // begins with two dots, exactly the changelog scenario
    const root = await makeTempRoot('occ-e35-dir-')
    const pluginDir = join(root, '..myplugin')
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'dotdot-plugin',
        version: '1.0.0',
        description: 'directory name begins with two dots',
        author: { name: 'occ-test' },
      }),
    )
    await writeMarketplace(root, [
      { name: 'dotdot-plugin', source: './..myplugin' },
    ])

    // Act
    const result = await validateManifest(root)

    // Assert — accepted, no traversal error
    expect(traversalErrors(result.errors)).toHaveLength(0)
    expect(result.success).toBe(true)
  })

  test('real traversal "foo/../bar" is still rejected', async () => {
    // Arrange
    const root = await makeTempRoot('occ-e35-mid-')
    const manifestPath = await writeMarketplace(root, [
      { name: 'evil-plugin', source: 'foo/../bar' },
    ])

    // Act
    const result = await validateMarketplaceManifest(manifestPath)

    // Assert
    const hits = traversalErrors(result.errors)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.path).toBe('plugins[0].source')
    expect(result.success).toBe(false)
  })

  test('bare ".." is still rejected', async () => {
    // Arrange
    const root = await makeTempRoot('occ-e35-bare-')
    const manifestPath = await writeMarketplace(root, [
      { name: 'evil-plugin', source: '..' },
    ])

    // Act
    const result = await validateMarketplaceManifest(manifestPath)

    // Assert
    const hits = traversalErrors(result.errors)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.path).toBe('plugins[0].source')
  })

  test('leading ".." segment ("../escape") is still rejected', async () => {
    // Arrange
    const root = await makeTempRoot('occ-e35-lead-')
    const manifestPath = await writeMarketplace(root, [
      { name: 'evil-plugin', source: './../escape' },
    ])

    // Act
    const result = await validateMarketplaceManifest(manifestPath)

    // Assert
    expect(traversalErrors(result.errors)).toHaveLength(1)
    expect(result.success).toBe(false)
  })

  test('"a/..b/c" is accepted (segment merely starts with two dots)', async () => {
    // Arrange — exercised through plugin.json commands so the whole validate
    // path stays green, not just the traversal predicate
    const root = await makeTempRoot('occ-e35-dotdotb-')
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    const manifestPath = join(root, '.claude-plugin', 'plugin.json')
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: 'dotdotb-plugin',
        version: '1.0.0',
        commands: ['./a/..b/c'],
      }),
    )

    // Act
    const result = await validatePluginManifest(manifestPath)

    // Assert
    expect(traversalErrors(result.errors)).toHaveLength(0)
    expect(result.success).toBe(true)
  })

  test('Windows-style backslash traversal is still rejected', async () => {
    // Arrange — the old substring check caught '..\\'; segment splitting on
    // both separators must keep that coverage
    const root = await makeTempRoot('occ-e35-win-')
    const manifestPath = await writeMarketplace(root, [
      { name: 'evil-plugin', source: './foo\\..\\bar' },
    ])

    // Act
    const result = await validateMarketplaceManifest(manifestPath)

    // Assert
    expect(traversalErrors(result.errors)).toHaveLength(1)
  })
})
