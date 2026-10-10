import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.296 marketplace-name recordability (official `L7e`/`D7e`/`gbn`
 * UnrecordablePluginIdError, category "plugin id cannot be a key of the
 * install records"; evidence: /tmp/cc296/ev-market296.txt + ev-market296b.txt).
 *
 * The 296 changelog bug: a marketplace named `constructor` (or `prototype`)
 * made `records[name]` reads hit the Object.prototype member — truthy! — so
 * marketplace update and plugin install failed with internal TypeErrors
 * instead of a clean refusal. Official fix: `add` refuses such names outright
 * (`e7e` chain) and every record-map access is an own-property lookup.
 *
 * Coverage:
 *   (a) isRecordableName / refusal-message pure units;
 *   (b) diffMarketplaces prototype-collision semantics (own-property read);
 *   (c) REAL addMarketplaceSource refusal via a filesystem sandbox
 *       (280-test pattern: CLAUDE_CODE_PLUGIN_CACHE_DIR + local directory
 *       marketplace fixture) + clean not-found paths for remove /
 *       getPluginByIdCacheOnly.
 *
 * NOTE: the memoized getMarketplace is deliberately never called with a
 * prototype-colliding name here — its rejected promise would be cached in
 * shared module state for sibling test files.
 */

import {
  addMarketplaceSource,
  getPluginByIdCacheOnly,
  removeMarketplaceSource,
} from '../marketplaceManager.js'
import { isRecordableName } from '../optionKeySafety.js'
import {
  buildMarketplaceNameRefusalMessage,
  buildUnrecordableMarketplaceNameMessage,
} from '../pluginIdentifier.js'
import { diffMarketplaces } from '../reconciler.js'
import type { KnownMarketplacesFile } from '../schemas.js'

// ---------------------------------------------------------------------------
// (a) pure units
// ---------------------------------------------------------------------------
describe('isRecordableName — names that cannot be a key of the install records', () => {
  test('refuses constructor / prototype / __proto__', () => {
    expect(isRecordableName('constructor')).toBe(false)
    expect(isRecordableName('prototype')).toBe(false)
    expect(isRecordableName('__proto__')).toBe(false)
  })

  test('accepts ordinary marketplace names', () => {
    expect(isRecordableName('my-marketplace')).toBe(true)
    expect(isRecordableName('agent.skills')).toBe(true)
    expect(isRecordableName('Constructor')).toBe(true) // case-sensitive, like the official Set
  })

  test('BOUNDARY (documented deviation scope): toString/valueOf are NOT refused', () => {
    // The official recordability schema targets names that collide with
    // install-record KEYS. `toString` is an Object.prototype member but every
    // OCC record read is an own-property lookup, so it is harmless; the task
    // scope pins the refusal set to {constructor, prototype, __proto__}.
    expect(isRecordableName('toString')).toBe(true)
    expect(isRecordableName('valueOf')).toBe(true)
  })
})

describe('buildUnrecordableMarketplaceNameMessage', () => {
  test('carries the official category wording verbatim', () => {
    const message = buildUnrecordableMarketplaceNameMessage('constructor')
    expect(message).toContain('Cannot add marketplace "constructor"')
    expect(message).toContain('cannot be a key of the install records')
    expect(message).toContain(
      'The name is set by "name" in the marketplace\'s marketplace.json; ask its maintainer to change it.',
    )
  })

  test('caps the displayed name at 64 chars (official je(ke, 64) display cap)', () => {
    const long = 'a'.repeat(100)
    const message = buildUnrecordableMarketplaceNameMessage(long)
    expect(message).toContain('a'.repeat(64))
    expect(message).not.toContain('a'.repeat(65))
  })
})

// ---------------------------------------------------------------------------
// (b) diffMarketplaces — own-property reads on the materialized records
// ---------------------------------------------------------------------------
const GITHUB_SOURCE = { source: 'github', repo: 'someone/somewhere' } as const

function materializedEntry(): KnownMarketplacesFile[string] {
  return {
    source: { ...GITHUB_SOURCE },
    installLocation: '/tmp/nowhere',
    lastUpdated: '2026-10-01T00:00:00.000Z',
  }
}

describe('diffMarketplaces — prototype-colliding names', () => {
  test('a declared `constructor` with no own materialized entry reports missing (NOT a crash / sourceChanged via Object.prototype)', () => {
    const diff = diffMarketplaces(
      { constructor: { source: { ...GITHUB_SOURCE } } },
      {},
    )
    expect(diff.missing).toEqual(['constructor'])
    expect(diff.sourceChanged).toEqual([])
    expect(diff.upToDate).toEqual([])
  })

  test('an own materialized `constructor` entry with the same source reports upToDate', () => {
    const materialized = JSON.parse(
      JSON.stringify({ constructor: materializedEntry() }),
    ) as KnownMarketplacesFile
    const diff = diffMarketplaces(
      { constructor: { source: { ...GITHUB_SOURCE } } },
      materialized,
    )
    expect(diff.upToDate).toEqual(['constructor'])
    expect(diff.missing).toEqual([])
    expect(diff.sourceChanged).toEqual([])
  })

  test('an own materialized `constructor` entry with a DIFFERENT source reports sourceChanged', () => {
    const entry = materializedEntry()
    entry.source = { source: 'github', repo: 'other/repo' }
    const materialized = JSON.parse(
      JSON.stringify({ constructor: entry }),
    ) as KnownMarketplacesFile
    const diff = diffMarketplaces(
      { constructor: { source: { ...GITHUB_SOURCE } } },
      materialized,
    )
    expect(diff.sourceChanged.map(s => s.name)).toEqual(['constructor'])
  })

  test('inherited-only members (toString) also report missing, not sourceChanged', () => {
    const diff = diffMarketplaces(
      { toString: { source: { ...GITHUB_SOURCE } } },
      {},
    )
    expect(diff.missing).toEqual(['toString'])
    expect(diff.sourceChanged).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// (c) filesystem-sandboxed REAL refusals (280-test pattern)
// ---------------------------------------------------------------------------
let sandbox: string
let savedCacheDir: string | undefined
let savedSeedDir: string | undefined

function knownMarketplacesPath(): string {
  return join(sandbox, 'known_marketplaces.json')
}

function writeKnownMarketplaces(entries: Record<string, unknown>): void {
  writeFileSync(knownMarketplacesPath(), JSON.stringify(entries, null, 2))
}

/** Local-directory marketplace fixture whose manifest declares `name`. */
function writeMarketplaceFixture(name: string): string {
  const marketplaceDir = join(sandbox, `fixture-${name.replace(/_/g, '-')}`)
  mkdirSync(join(marketplaceDir, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name, owner: { name: 'collider' }, plugins: [] }),
  )
  return marketplaceDir
}

async function captureAddRefusal(name: string): Promise<string> {
  const marketplaceDir = writeMarketplaceFixture(name)
  try {
    await addMarketplaceSource({ source: 'directory', path: marketplaceDir })
    return '' // no refusal — caller asserts this never happens
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

describe('REAL addMarketplaceSource / record lookups — sandboxed', () => {
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'mcn296-'))
    mkdirSync(join(sandbox, 'marketplaces'), { recursive: true })
    savedCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    savedSeedDir = process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = sandbox
    writeKnownMarketplaces({})
  })

  afterEach(() => {
    if (savedCacheDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = savedCacheDir
    }
    if (savedSeedDir === undefined) {
      delete process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
    } else {
      process.env.CLAUDE_CODE_PLUGIN_SEED_DIR = savedSeedDir
    }
    rmSync(sandbox, { recursive: true, force: true })
  })

  test('add refuses a marketplace named `constructor` with the unrecordable-name message', async () => {
    const message = await captureAddRefusal('constructor')
    expect(message).toBe(buildUnrecordableMarketplaceNameMessage('constructor'))
    // Nothing was recorded.
    expect(JSON.parse(readFileSync(knownMarketplacesPath(), 'utf8'))).toEqual({})
  })

  test('add refuses a marketplace named `prototype` with the unrecordable-name message', async () => {
    const message = await captureAddRefusal('prototype')
    expect(message).toBe(buildUnrecordableMarketplaceNameMessage('prototype'))
    expect(JSON.parse(readFileSync(knownMarketplacesPath(), 'utf8'))).toEqual({})
  })

  test('add refuses `__proto__` too (intercepted by the earlier 295 plugin-id-part rule — still a clean refusal, no prototype write)', async () => {
    // '__proto__' fails isValidPluginIdPart (must start with a letter/digit),
    // so the 295 refusal fires before the 296 recordability refusal. Either
    // way: clean Error, nothing recorded, Object.prototype untouched.
    const message = await captureAddRefusal('__proto__')
    expect(message).toBe(buildMarketplaceNameRefusalMessage('__proto__'))
    expect(JSON.parse(readFileSync(knownMarketplacesPath(), 'utf8'))).toEqual({})
  })

  test('removeMarketplaceSource(`constructor`) reports a clean not-found instead of an internal TypeError', async () => {
    let message = ''
    try {
      await removeMarketplaceSource('constructor')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toBe("Marketplace 'constructor' not found")
  })

  test('getPluginByIdCacheOnly resolves through a prototype-colliding marketplace name to null (no crash)', async () => {
    expect(await getPluginByIdCacheOnly('plug@constructor')).toBeNull()
    expect(await getPluginByIdCacheOnly('plug@prototype')).toBeNull()
    expect(await getPluginByIdCacheOnly('plug@toString')).toBeNull()
  })
})
