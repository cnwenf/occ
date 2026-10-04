import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectColocatedPluginKind,
  isAnthropicMarketplaceName,
  marketplaceEntryListsFolder,
  validateColocatedPlugin,
  validateManifest,
  validatePluginManifest,
} from '../validatePlugin.js'

/**
 * CC 2.1.289 changelog #16 + #22(a) — `plugin validate` on a folder whose
 * `.claude-plugin/` holds BOTH marketplace.json and plugin.json.
 *
 * #16: v288's validate reader (official `kTt` @v288:236232779) returned the
 * marketplace result and NEVER validated the co-located plugin.json — OCC
 * mirrored the bug via validateManifest's early return (@901-903). v289's
 * `JTt` @v289:236588478 adds the co-location branch: when the user pointed at
 * the FOLDER (`T.resolve(n)!==a` gate) and `.claude-plugin/plugin.json`
 * exists (non-ENOENT), it is validated too and reported only when it has
 * findings — official `f` gate: `d.errors.length>0||d.warnings.length>0||
 * (d.notes?.length??0)>0` (OCC's ValidationResult has no `notes` field — see
 * #22(b) NO-OP) — alongside the plugin's content files (official `je(a)`).
 *
 * #22(a): the co-located plugin.json is validated with kind "anthropic" when
 * the marketplace manifest parses under the official LENIENT reader
 * (`Me` @v289:236544255: readFile→JSON→schema safeParse→data|undefined),
 * its name is one of Anthropic's (official `qCn` @v289:200231909 =
 * `jMe` @200231492 [14 names] ∪ `Ai=["healthcare"]` @200231407 — NOT the
 * `n4t` community names) AND its plugins[] lists THIS folder (official
 * `Ae(entry,root,folder)` @v289:236544054 = `typeof source==="string" &&
 * Yt(resolve(root,source),folder)`; `Yt(a,b)=Ye(resolve(a))===Ye(resolve(b))`,
 * `Ye` strips one trailing `sep` @236543967).
 *
 * Recorded deviation from the research doc's #22(a) gloss: the doc annotates
 * `eAt` as "the claude.ai-sync kebab-case / name rule", but the binary shows
 * the kind gate @v289:236553486 (`s.kind==="alone"||s.kind==="entry"&&
 * s.entryName!==m.name?eAt(m.name):void 0`) gates ONLY `eAt` @v289:227489997
 * — the reserved-name/imitation checker ("If this is one of Anthropic's own
 * plugins, validate the marketplace that lists it." `Puo` @227489908). The
 * kebab-case warning @v289:236553327 is UNCONDITIONAL in both versions (single
 * `s.kind` reference in the validator chunk). OCC has no `eAt` analogue, so
 * the kind is threaded through validatePluginManifest for parity (official
 * `de(n,r={kind:"alone"})` @v289:236548207) and is unobservable today — these
 * tests pin the DETECTION itself plus the binary-faithful fact that the kebab
 * warning is NOT suppressed for anthropic kind.
 */

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

/** A plugin.json object that validates with zero errors AND zero warnings. */
const CLEAN_PLUGIN = {
  name: 'demo-plugin',
  version: '1.0.0',
  description: 'demo plugin for the CC 2.1.289 co-location tests',
  author: { name: 'occ-test' },
}

async function writeMarketplace(
  root: string,
  name: string,
  plugins: unknown[],
): Promise<string> {
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  const filePath = join(root, '.claude-plugin', 'marketplace.json')
  await writeFile(
    filePath,
    JSON.stringify(
      {
        name,
        owner: { name: 'occ-test' },
        plugins,
        metadata: { description: 'test marketplace' },
      },
      null,
      2,
    ),
  )
  return filePath
}

async function writePluginJson(
  root: string,
  content: string,
): Promise<string> {
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  const filePath = join(root, '.claude-plugin', 'plugin.json')
  await writeFile(filePath, content)
  return filePath
}

function hasKebabWarning(result: {
  warnings: Array<{ message: string }>
}): boolean {
  return result.warnings.some(w => w.message.includes('not kebab-case'))
}

describe('CC 2.1.289 #16 — co-located plugin.json is validated with the marketplace', () => {
  test('folder with marketplace.json + INVALID plugin.json reports BOTH results (v288 early-return bug)', async () => {
    // Arrange — valid marketplace listing this folder, truncated plugin.json
    const root = await makeTempRoot('occ289-coloc-')
    await writeMarketplace(root, 'occ-test-market', [
      { name: 'demo-plugin', source: './' },
    ])
    const pluginPath = await writePluginJson(
      root,
      '{"name": "demo-plugin", "version": ',
    )

    // Act
    const marketplaceResult = await validateManifest(root)
    expect(marketplaceResult.fileType).toBe('marketplace')
    const colocated = await validateColocatedPlugin(root, marketplaceResult)

    // Assert — the co-located plugin result is reported next to the marketplace
    expect(colocated).not.toBeNull()
    expect(colocated?.pluginResult).not.toBeNull()
    expect(colocated?.pluginResult?.fileType).toBe('plugin')
    expect(colocated?.pluginResult?.filePath).toBe(pluginPath)
    expect(colocated?.pluginResult?.success).toBe(false)
    expect(colocated?.pluginResult?.errors[0]?.message).toContain(
      'Invalid JSON syntax',
    )
  })

  test('CLEAN co-located plugin.json is NOT listed (official f-gate) but content files still are', async () => {
    // Arrange — clean marketplace + clean plugin.json + one command file
    // without frontmatter (validateComponentFile → deterministic warning)
    const root = await makeTempRoot('occ289-clean-')
    await writeMarketplace(root, 'occ-test-market', [
      { name: 'demo-plugin', source: './' },
    ])
    await writePluginJson(root, JSON.stringify(CLEAN_PLUGIN))
    await mkdir(join(root, 'commands'), { recursive: true })
    await writeFile(join(root, 'commands', 'hello.md'), 'Say hello.\n')

    // Act
    const marketplaceResult = await validateManifest(root)
    const colocated = await validateColocatedPlugin(root, marketplaceResult)

    // Assert — official contents = [...f?[d]:[], ...je(a)] with f=false
    expect(colocated).not.toBeNull()
    expect(colocated?.pluginResult).toBeNull()
    expect(colocated?.contents.length).toBe(1)
    expect(colocated?.contents[0]?.fileType).toBe('command')
    expect(colocated?.contents[0]?.warnings.length).toBeGreaterThan(0)
  })

  test('marketplace.json WITHOUT co-located plugin.json returns null (official ENOENT gate)', async () => {
    // Arrange
    const root = await makeTempRoot('occ289-noplugin-')
    await writeMarketplace(root, 'occ-test-market', [
      { name: 'demo-plugin', source: './' },
    ])

    // Act
    const marketplaceResult = await validateManifest(root)
    const colocated = await validateColocatedPlugin(root, marketplaceResult)

    // Assert — official: `d.errors[0]?.code==="ENOENT"` → contents stay empty
    expect(colocated).toBeNull()
  })

  test('marketplace.json path passed DIRECTLY (not the folder) returns null (official resolve(n)!==a gate)', async () => {
    // Arrange
    const root = await makeTempRoot('occ289-direct-')
    const marketplacePath = await writeMarketplace(root, 'occ-test-market', [
      { name: 'demo-plugin', source: './' },
    ])
    await writePluginJson(root, '{"name": "demo-plugin", "version": ')

    // Act
    const marketplaceResult = await validateManifest(marketplacePath)
    expect(marketplaceResult.fileType).toBe('marketplace')
    const colocated = await validateColocatedPlugin(
      marketplacePath,
      marketplaceResult,
    )

    // Assert — official JTt only co-validates when the INPUT was the folder
    expect(colocated).toBeNull()
  })

  test('INVALID marketplace.json does not block co-located plugin validation', async () => {
    // Arrange — malformed marketplace + plugin.json with a traversal error
    const root = await makeTempRoot('occ289-badmarket-')
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(root, '.claude-plugin', 'marketplace.json'),
      '{ not json',
    )
    await writePluginJson(
      root,
      JSON.stringify({ ...CLEAN_PLUGIN, commands: ['../evil.md'] }),
    )

    // Act
    const marketplaceResult = await validateManifest(root)
    expect(marketplaceResult.success).toBe(false)
    const colocated = await validateColocatedPlugin(root, marketplaceResult)

    // Assert — both results reported; the plugin error is the traversal one
    expect(colocated?.pluginResult).not.toBeNull()
    expect(
      colocated?.pluginResult?.errors.some(e => e.path === 'commands[0]'),
    ).toBe(true)
  })

  test('validateManifest keeps its single-result signature (doc option b: composition lives in the CLI handler)', async () => {
    // Arrange
    const root = await makeTempRoot('occ289-sig-')
    await writeMarketplace(root, 'occ-test-market', [
      { name: 'demo-plugin', source: './' },
    ])
    await writePluginJson(root, JSON.stringify(CLEAN_PLUGIN))

    // Act
    const result = await validateManifest(root)

    // Assert — still exactly one ValidationResult, marketplace wins the branch
    expect(result.fileType).toBe('marketplace')
  })
})

describe('CC 2.1.289 #22(a) — anthropic-kind detection (official qCn + Ae)', () => {
  test('isAnthropicMarketplaceName mirrors official qCn = jMe (14 names) ∪ Ai(["healthcare"]), case-insensitive', () => {
    // Official jMe @v289:200231492 — order/spelling verbatim
    const officialNames = [
      'claude-code-marketplace',
      'claude-code-plugins',
      'claude-plugins-official',
      'anthropic-marketplace',
      'anthropic-plugins',
      'agent-skills',
      'anthropic-agent-skills',
      'life-sciences',
      'knowledge-work-plugins',
      'claude-for-legal',
      'claude-for-financial-services',
      'financial-services-plugins',
      'first-party-plugins',
      'claude-tag-plugins',
    ]
    for (const name of officialNames) {
      expect(isAnthropicMarketplaceName(name)).toBe(true)
      expect(isAnthropicMarketplaceName(name.toUpperCase())).toBe(true)
    }
    // Ai @v289:200231407 = ["healthcare"]
    expect(isAnthropicMarketplaceName('healthcare')).toBe(true)
    expect(isAnthropicMarketplaceName('Healthcare')).toBe(true)
    // qCn does NOT include the n4t community names (claude-community set)
    expect(isAnthropicMarketplaceName('claude-community')).toBe(false)
    expect(isAnthropicMarketplaceName('claude-plugins-community')).toBe(false)
    // Xsr plugin-directory reserved names are not Anthropic-own either
    expect(isAnthropicMarketplaceName('anthropic-plugin-directory')).toBe(false)
    expect(isAnthropicMarketplaceName('claude-plugin-directory')).toBe(false)
    expect(isAnthropicMarketplaceName('my-market')).toBe(false)
    expect(isAnthropicMarketplaceName('')).toBe(false)
  })

  test('marketplaceEntryListsFolder mirrors official Ae (string source resolved against the marketplace root)', () => {
    expect(marketplaceEntryListsFolder({ source: './' }, '/m/root', '/m/root')).toBe(true)
    expect(marketplaceEntryListsFolder({ source: '.' }, '/m/root', '/m/root')).toBe(true)
    expect(marketplaceEntryListsFolder({ source: './sub' }, '/m/root', '/m/root/sub')).toBe(true)
    expect(marketplaceEntryListsFolder({ source: './sub' }, '/m/root', '/m/root')).toBe(false)
    // Official Ae: `typeof i==="string"&&...` — object sources never match
    expect(
      marketplaceEntryListsFolder(
        { source: { source: 'github', repo: 'a/b' } },
        '/m/root',
        '/m/root',
      ),
    ).toBe(false)
    expect(marketplaceEntryListsFolder({}, '/m/root', '/m/root')).toBe(false)
  })

  test('detectColocatedPluginKind → anthropic when an anthropic-named marketplace lists THIS folder', async () => {
    const root = await makeTempRoot('occ289-kind-')
    await writeMarketplace(root, 'anthropic-marketplace', [
      { name: 'demo-plugin', source: './' },
    ])
    expect(
      await detectColocatedPluginKind(
        join(root, '.claude-plugin', 'marketplace.json'),
        root,
      ),
    ).toBe('anthropic')
  })

  test('detectColocatedPluginKind → anthropic for the healthcare alias (Ai)', async () => {
    const root = await makeTempRoot('occ289-health-')
    await writeMarketplace(root, 'healthcare', [
      { name: 'demo-plugin', source: './' },
    ])
    expect(
      await detectColocatedPluginKind(
        join(root, '.claude-plugin', 'marketplace.json'),
        root,
      ),
    ).toBe('anthropic')
  })

  test('detectColocatedPluginKind → alone for a non-anthropic marketplace name', async () => {
    const root = await makeTempRoot('occ289-plain-')
    await writeMarketplace(root, 'occ-test-market', [
      { name: 'demo-plugin', source: './' },
    ])
    expect(
      await detectColocatedPluginKind(
        join(root, '.claude-plugin', 'marketplace.json'),
        root,
      ),
    ).toBe('alone')
  })

  test('detectColocatedPluginKind → alone for a community-reserved name (qCn excludes n4t)', async () => {
    const root = await makeTempRoot('occ289-community-')
    await writeMarketplace(root, 'claude-community', [
      { name: 'demo-plugin', source: './' },
    ])
    expect(
      await detectColocatedPluginKind(
        join(root, '.claude-plugin', 'marketplace.json'),
        root,
      ),
    ).toBe('alone')
  })

  test('detectColocatedPluginKind → alone when an anthropic marketplace lists a DIFFERENT folder', async () => {
    const root = await makeTempRoot('occ289-otherdir-')
    await writeMarketplace(root, 'anthropic-marketplace', [
      { name: 'other', source: './plugins/other' },
    ])
    expect(
      await detectColocatedPluginKind(
        join(root, '.claude-plugin', 'marketplace.json'),
        root,
      ),
    ).toBe('alone')
  })

  test('detectColocatedPluginKind → alone when marketplace.json is malformed or missing (official lenient reader Me)', async () => {
    const malformed = await makeTempRoot('occ289-malformed-')
    await mkdir(join(malformed, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(malformed, '.claude-plugin', 'marketplace.json'),
      '{ broken json',
    )
    expect(
      await detectColocatedPluginKind(
        join(malformed, '.claude-plugin', 'marketplace.json'),
        malformed,
      ),
    ).toBe('alone')

    const missing = await makeTempRoot('occ289-nofile-')
    expect(
      await detectColocatedPluginKind(
        join(missing, '.claude-plugin', 'marketplace.json'),
        missing,
      ),
    ).toBe('alone')
  })

  test('anthropic kind does NOT suppress the kebab-case warning (binary-faithful: official gates only eAt, which OCC lacks)', async () => {
    // Arrange — anthropic marketplace listing a non-kebab-named plugin
    const root = await makeTempRoot('occ289-kebab-')
    await writeMarketplace(root, 'anthropic-marketplace', [
      { name: 'Demo_Plugin', source: './' },
    ])
    const pluginPath = await writePluginJson(
      root,
      JSON.stringify({ ...CLEAN_PLUGIN, name: 'Demo_Plugin' }),
    )

    // Detection says anthropic...
    expect(
      await detectColocatedPluginKind(
        join(root, '.claude-plugin', 'marketplace.json'),
        root,
      ),
    ).toBe('anthropic')

    // ...but the kebab warning still fires under BOTH kinds — the official
    // kebab check @v289:236553327 carries no kind condition; the only kind
    // gate @236553486 wraps eAt @227489997 (reserved-name/imitation rule).
    expect(hasKebabWarning(await validatePluginManifest(pluginPath, 'alone'))).toBe(true)
    expect(
      hasKebabWarning(await validatePluginManifest(pluginPath, 'anthropic')),
    ).toBe(true)

    // End-to-end through the co-located path: f-gate counts the warning, so
    // the plugin result IS listed with the kebab warning intact.
    const marketplaceResult = await validateManifest(root)
    const colocated = await validateColocatedPlugin(root, marketplaceResult)
    expect(colocated?.pluginResult).not.toBeNull()
    expect(hasKebabWarning(colocated?.pluginResult ?? { warnings: [] })).toBe(
      true,
    )
  })

  test('validatePluginManifest kind defaults to "alone" with identical results (official de(n,r={kind:"alone"}))', async () => {
    const root = await makeTempRoot('occ289-default-')
    const pluginPath = await writePluginJson(
      root,
      JSON.stringify({ ...CLEAN_PLUGIN, name: 'Demo_Plugin' }),
    )
    const defaulted = await validatePluginManifest(pluginPath)
    const explicit = await validatePluginManifest(pluginPath, 'alone')
    expect(defaulted).toEqual(explicit)
  })
})
