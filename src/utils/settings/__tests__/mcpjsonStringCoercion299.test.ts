/**
 * CC 2.1.299 #055 — a settings file whose `enabledMcpjsonServers` /
 * `disabledMcpjsonServers` is a SINGLE PLAIN STRING (e.g. "my-server") must
 * not cause the whole file to be ignored: official v299 coerces it to a
 * one-element list before schema validation.
 *
 * Official evidence (v299 binary, NEW — v296 has no coercion):
 *  - `gb`/`mb`/`pOr` @215649900:
 *      var gb=["enabledMcpjsonServers","disabledMcpjsonServers"],
 *          mb=/^[A-Za-z0-9_-]+$/;
 *      function pOr(e){if(!L(e))return;for(let n of gb){let r=e[n];
 *        if(typeof r==="string"&&mb.test(r))e[n]=[r]}}
 *  - settings-validation entry `Tt` @215650380: `if(!r?.policySource)pOr(e)`
 *    — NON-policy sources only.
 *
 * OCC implementation: `coerceMcpjsonServerStrings` in
 * src/utils/settings/types.ts, called from parseSettingsFileUncached's
 * non-policy branch (settings.ts) before stripManagedOnlyKeys/safeParse.
 *
 * Known divergence (documented, not tested as parity): OCC's non-policy
 * schema parse is all-or-nothing — a GARBAGE string (failing `mb`) is left
 * untouched and rejects the whole file, whereas the official per-key salvage
 * would keep the other keys. The policy branch stays strict (no coercion).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseSettingsFile } from '../settings.js'
import {
  coerceMcpjsonServerStrings,
  MCPJSON_SERVER_LIST_KEYS,
  MCPJSON_SERVER_NAME_PATTERN,
} from '../types.js'

const tempDirs: string[] = []
let fileCounter = 0

/** Unique path per case — parseSettingsFile caches by path. */
function makeSettingsFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-mcpjson-299-'))
  tempDirs.push(dir)
  fileCounter += 1
  const filePath = join(dir, `settings-${fileCounter}.json`)
  writeFileSync(filePath, content, 'utf8')
  return filePath
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('#055 coerceMcpjsonServerStrings — unit (official pOr)', () => {
  test('coerces a single plain string to a one-element list (both keys)', () => {
    // Arrange
    const data: Record<string, unknown> = {
      enabledMcpjsonServers: 'my-server_1',
      disabledMcpjsonServers: 'Other-Server_2',
    }

    // Act
    coerceMcpjsonServerStrings(data)

    // Assert
    expect(data.enabledMcpjsonServers).toEqual(['my-server_1'])
    expect(data.disabledMcpjsonServers).toEqual(['Other-Server_2'])
  })

  test('leaves an array unchanged', () => {
    // Arrange
    const data: Record<string, unknown> = {
      enabledMcpjsonServers: ['a', 'b'],
      disabledMcpjsonServers: [],
    }

    // Act
    coerceMcpjsonServerStrings(data)

    // Assert
    expect(data.enabledMcpjsonServers).toEqual(['a', 'b'])
    expect(data.disabledMcpjsonServers).toEqual([])
  })

  test('leaves garbage strings (spaces/symbols/empty) untouched', () => {
    // Arrange — official `mb` = /^[A-Za-z0-9_-]+$/ rejects these
    const data: Record<string, unknown> = {
      enabledMcpjsonServers: 'has space',
      disabledMcpjsonServers: 'sym!bol',
    }
    const emptyData: Record<string, unknown> = {
      enabledMcpjsonServers: '',
    }

    // Act
    coerceMcpjsonServerStrings(data)
    coerceMcpjsonServerStrings(emptyData)

    // Assert
    expect(data.enabledMcpjsonServers).toBe('has space')
    expect(data.disabledMcpjsonServers).toBe('sym!bol')
    expect(emptyData.enabledMcpjsonServers).toBe('')
  })

  test('no-ops on non-plain-object inputs without throwing', () => {
    // Arrange / Act / Assert — official `if(!L(e))return`
    expect(() => coerceMcpjsonServerStrings(null)).not.toThrow()
    expect(() => coerceMcpjsonServerStrings(undefined)).not.toThrow()
    expect(() => coerceMcpjsonServerStrings('enabledMcpjsonServers')).not.toThrow()
    expect(() => coerceMcpjsonServerStrings(['enabledMcpjsonServers'])).not.toThrow()
    expect(() => coerceMcpjsonServerStrings(42)).not.toThrow()
  })

  test('constants match the official gb/mb verbatim', () => {
    // Assert
    expect([...MCPJSON_SERVER_LIST_KEYS]).toEqual([
      'enabledMcpjsonServers',
      'disabledMcpjsonServers',
    ])
    expect(MCPJSON_SERVER_NAME_PATTERN.source).toBe('^[A-Za-z0-9_-]+$')
  })
})

describe('#055 parseSettingsFile — string value no longer kills the whole file', () => {
  test('single-string enabledMcpjsonServers → file loads with coerced list', () => {
    // Arrange
    const filePath = makeSettingsFile(
      JSON.stringify({
        enabledMcpjsonServers: 'srv-a',
        theme: 'dark',
      }),
    )

    // Act
    const { settings, errors } = parseSettingsFile(filePath)

    // Assert — pre-fix this file was WHOLLY ignored (settings: null)
    expect(settings).not.toBeNull()
    expect(settings?.enabledMcpjsonServers).toEqual(['srv-a'])
    expect(settings?.theme).toBe('dark')
    expect(
      errors.filter(e => e.path.includes('enabledMcpjsonServers')),
    ).toEqual([])
  })

  test('single-string disabledMcpjsonServers → coerced too', () => {
    // Arrange
    const filePath = makeSettingsFile(
      JSON.stringify({ disabledMcpjsonServers: 'srv-b' }),
    )

    // Act
    const { settings } = parseSettingsFile(filePath)

    // Assert
    expect(settings).not.toBeNull()
    expect(settings?.disabledMcpjsonServers).toEqual(['srv-b'])
  })

  test('array value → unchanged through the full parse', () => {
    // Arrange
    const filePath = makeSettingsFile(
      JSON.stringify({ enabledMcpjsonServers: ['x', 'y'] }),
    )

    // Act
    const { settings } = parseSettingsFile(filePath)

    // Assert
    expect(settings).not.toBeNull()
    expect(settings?.enabledMcpjsonServers).toEqual(['x', 'y'])
  })

  test('garbage string → key invalid; OCC all-or-nothing rejects the file (documented divergence)', () => {
    // Arrange
    const filePath = makeSettingsFile(
      JSON.stringify({ enabledMcpjsonServers: 'has space', theme: 'dark' }),
    )

    // Act
    const { settings, errors } = parseSettingsFile(filePath)

    // Assert — official per-key salvage would keep `theme`; OCC's non-policy
    // schema parse is all-or-nothing, so the file is rejected with a zod
    // error naming the key. Documented in the file header.
    expect(settings).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => e.path.includes('enabledMcpjsonServers'))).toBe(
      true,
    )
  })

  test('policy source is NOT coerced (official Tt: if(!r?.policySource)pOr(e))', () => {
    // Arrange — same content, parsed as a policy source
    const filePath = makeSettingsFile(
      JSON.stringify({ enabledMcpjsonServers: 'srv-policy' }),
    )

    // Act
    const { settings } = parseSettingsFile(filePath, { policySource: true })

    // Assert — strict policy parse: the string is NOT coerced. Either the
    // field is dropped/substituted per the strict schema, but it must not
    // come back as the coerced ['srv-policy'].
    expect(settings?.enabledMcpjsonServers).not.toEqual(['srv-policy'])
  })
})
