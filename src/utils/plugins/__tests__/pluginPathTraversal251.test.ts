import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginError } from '../../../types/plugin.js'
import { createPluginFromPath } from '../pluginLoader.js'

/**
 * CC 2.1.251 security fix (changelog #7, Gap-109e): plugin component paths
 * could escape the plugin directory. The official binary normalizes every
 * relative component path (Ibe) and rejects anything that resolves outside
 * the plugin root; OCC ports that containment as resolveContainedPluginPath,
 * wired into validatePluginPaths (agents/skills/output-styles), all six
 * command-path sites (manifest + marketplace, array and source forms), and
 * the manifest hooks site.
 *
 * The manifest schema requires a './' prefix on relative paths, so the
 * attack shape that actually reaches the loader is a './'-prefixed traversal
 * ('./../x.md') — exactly what the containment check must stop. Exercised
 * behaviorally through the exported createPluginFromPath.
 */

const SOURCE = 'test:109e-fixture'

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.allSettled(
    tempRoots.map(root => rm(root, { recursive: true, force: true })),
  )
})

async function makeFixture(name: string, manifest: Record<string, unknown>) {
  const base = await mkdtemp(join(tmpdir(), 'occ-109e-'))
  tempRoots.push(base)
  // Real files OUTSIDE the plugin directory — the traversal targets.
  await writeFile(join(base, 'stolen.md'), '# stolen\n')
  await writeFile(join(base, 'evil-hooks.json'), '{}')
  const pluginDir = join(base, name)
  await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, ...manifest }),
  )
  return { base, pluginDir }
}

function traversals(errors: PluginError[]) {
  return errors.filter(e => e.type === 'path-traversal')
}

describe('2.1.251: plugin path traversal containment (Gap-109e)', () => {
  test('manifest array-form command path cannot escape the plugin directory', async () => {
    // Arrange — the target file EXISTS outside the plugin dir, so only the
    // containment check (not a missing-file check) can stop it.
    const { pluginDir } = await makeFixture('evil-cmd-array', {
      commands: ['./../stolen.md'],
    })

    // Act
    const { plugin, errors } = await createPluginFromPath(
      pluginDir,
      SOURCE,
      true,
      'evil-cmd-array',
    )

    // Assert
    const hits = traversals(errors)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      type: 'path-traversal',
      source: SOURCE,
      plugin: 'evil-cmd-array',
      path: './../stolen.md',
      component: 'commands',
    })
    expect(plugin.commandsPaths ?? []).toHaveLength(0)
  })

  test('manifest object-mapping command source cannot escape', async () => {
    // Arrange
    const { pluginDir } = await makeFixture('evil-cmd-source', {
      commands: { steal: { source: './../stolen.md' } },
    })

    // Act
    const { plugin, errors } = await createPluginFromPath(
      pluginDir,
      SOURCE,
      true,
      'evil-cmd-source',
    )

    // Assert
    const hits = traversals(errors)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      type: 'path-traversal',
      path: './../stolen.md',
      component: 'commands',
    })
    expect(plugin.commandsPaths ?? []).toHaveLength(0)
  })

  test('manifest agents path cannot escape', async () => {
    // Arrange
    const { pluginDir } = await makeFixture('evil-agents', {
      agents: ['./../stolen.md'],
    })

    // Act
    const { plugin, errors } = await createPluginFromPath(
      pluginDir,
      SOURCE,
      true,
      'evil-agents',
    )

    // Assert
    const hits = traversals(errors)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      type: 'path-traversal',
      path: './../stolen.md',
      component: 'agents',
    })
    expect(plugin.agentsPaths ?? []).toHaveLength(0)
  })

  test('manifest skills path cannot escape', async () => {
    // Arrange
    const { pluginDir } = await makeFixture('evil-skills', {
      skills: ['./../skills-escape'],
    })

    // Act
    const { errors } = await createPluginFromPath(
      pluginDir,
      SOURCE,
      true,
      'evil-skills',
    )

    // Assert
    const hits = traversals(errors)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      type: 'path-traversal',
      path: './../skills-escape',
      component: 'skills',
    })
  })

  test('manifest hooks file path cannot escape', async () => {
    // Arrange
    const { pluginDir } = await makeFixture('evil-hooks', {
      hooks: './../evil-hooks.json',
    })

    // Act
    const { errors } = await createPluginFromPath(
      pluginDir,
      SOURCE,
      true,
      'evil-hooks',
    )

    // Assert
    const hits = traversals(errors)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      type: 'path-traversal',
      path: './../evil-hooks.json',
      component: 'hooks',
    })
  })

  test('legitimate relative paths still load (no false positive)', async () => {
    // Arrange
    const { pluginDir } = await makeFixture('good-plugin', {
      commands: ['./commands/hello.md'],
    })
    await mkdir(join(pluginDir, 'commands'), { recursive: true })
    await writeFile(join(pluginDir, 'commands', 'hello.md'), '# hello\n')

    // Act
    const { plugin, errors } = await createPluginFromPath(
      pluginDir,
      SOURCE,
      true,
      'good-plugin',
    )

    // Assert
    expect(traversals(errors)).toHaveLength(0)
    expect(plugin.commandsPaths).toEqual([join(pluginDir, 'commands', 'hello.md')])
  })

  test('bare traversal (no ./ prefix) is rejected earlier by the manifest schema', async () => {
    // Defense in depth: paths without the './' prefix never reach the
    // loader — the manifest schema rejects them first.
    const { pluginDir } = await makeFixture('schema-rejects', {
      commands: ['../stolen.md'],
    })

    await expect(
      createPluginFromPath(pluginDir, SOURCE, true, 'schema-rejects'),
    ).rejects.toThrow(/invalid manifest/)
  })
})
