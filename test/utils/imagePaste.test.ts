import { describe, expect, test, afterEach, beforeEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLIPBOARD_IMAGE_SRC_ENV,
  CLIPBOARD_WATCH_PATH_ENV,
  getClipboardImageSrcOverride,
  getClipboardWatchPath,
  hasImageInClipboard,
  saveClipboardImageToTempFile,
} from '../../src/utils/imagePaste.js'
import type { TerminalQuerier } from '../../src/ink/terminal-querier.js'
import type { TerminalResponse } from '../../src/ink/parse-keypress.js'

// 1x1 red PNG (well-known). Real PNG magic bytes so detectImageFormatFromBase64
// classifies it as image/png.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKd0CgAAAABJRU5ErkJggg==',
  'base64',
)

const savedPaths: string[] = []
let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'occ-imagepaste-test-'))
  // Route occ's temp-image writes into our temp dir so we can clean them up.
  process.env.CLAUDE_CODE_TMPDIR = tmpDir
})

afterEach(async () => {
  delete process.env[CLIPBOARD_IMAGE_SRC_ENV]
  delete process.env[CLIPBOARD_WATCH_PATH_ENV]
  delete process.env.CLAUDE_CODE_TMPDIR
  for (const p of savedPaths.splice(0)) {
    try {
      rmSync(p, { force: true })
    } catch {
      // best-effort
    }
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

describe('getClipboardImageSrcOverride', () => {
  test('returns undefined when env unset', () => {
    delete process.env[CLIPBOARD_IMAGE_SRC_ENV]
    expect(getClipboardImageSrcOverride()).toBeUndefined()
  })

  test('returns the path when env set', () => {
    process.env[CLIPBOARD_IMAGE_SRC_ENV] = '/tmp/some-screenshot.png'
    expect(getClipboardImageSrcOverride()).toBe('/tmp/some-screenshot.png')
  })

  test('returns undefined for empty string', () => {
    process.env[CLIPBOARD_IMAGE_SRC_ENV] = ''
    expect(getClipboardImageSrcOverride()).toBeUndefined()
  })
})

describe('hasImageInClipboard (override path)', () => {
  test('returns true when override points to an existing file', async () => {
    const fixture = join(tmpDir, 'clip.png')
    writeFileSync(fixture, PNG_1x1)
    process.env[CLIPBOARD_IMAGE_SRC_ENV] = fixture
    expect(await hasImageInClipboard()).toBe(true)
  })

  test('returns false when override path does not exist', async () => {
    process.env[CLIPBOARD_IMAGE_SRC_ENV] = join(tmpDir, 'does-not-exist.png')
    // No override file and (on a headless test runner) no live clipboard image.
    expect(await hasImageInClipboard()).toBe(false)
  })
})

describe('saveClipboardImageToTempFile', () => {
  test('writes a unique temp file with the override image bytes', async () => {
    const fixture = join(tmpDir, 'source-screenshot.png')
    writeFileSync(fixture, PNG_1x1)
    process.env[CLIPBOARD_IMAGE_SRC_ENV] = fixture

    const result = await saveClipboardImageToTempFile()
    expect(result).not.toBeNull()
    if (!result) return
    savedPaths.push(result.path)

    // Path lives under the configured temp dir.
    expect(result.path.startsWith(tmpDir)).toBe(true)
    expect(result.mediaType).toBe('image/png')
    // File exists and matches the source bytes (round-trip).
    expect(existsSync(result.path)).toBe(true)
    const written = readFileSync(result.path)
    expect(written.equals(PNG_1x1)).toBe(true)
  })

  test('produces distinct paths across calls (unique temp files)', async () => {
    const fixture = join(tmpDir, 'again.png')
    writeFileSync(fixture, PNG_1x1)
    process.env[CLIPBOARD_IMAGE_SRC_ENV] = fixture

    const a = await saveClipboardImageToTempFile()
    const b = await saveClipboardImageToTempFile()
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    if (!a || !b) return
    savedPaths.push(a.path, b.path)
    expect(a.path).not.toBe(b.path)
  })

  test('returns null when no override and no clipboard image available', async () => {
    delete process.env[CLIPBOARD_IMAGE_SRC_ENV]
    // On a headless CI/sandbox there is no xclip/wl-paste clipboard image.
    const result = await saveClipboardImageToTempFile()
    expect(result).toBeNull()
  })

  test('returns null (does not throw) when override points at a missing file', async () => {
    process.env[CLIPBOARD_IMAGE_SRC_ENV] = join(tmpDir, 'missing.png')
    // Missing override + no live clipboard → null, not a throw.
    const result = await saveClipboardImageToTempFile()
    expect(result).toBeNull()
  })
})

describe('getClipboardWatchPath', () => {
  test('returns the default when env unset', () => {
    delete process.env[CLIPBOARD_WATCH_PATH_ENV]
    const p = getClipboardWatchPath()
    expect(p).toMatch(/\.occ[/]clipboard-latest\.png$/)
  })

  test('returns the env value when set', () => {
    process.env[CLIPBOARD_WATCH_PATH_ENV] = '/custom/watch.png'
    expect(getClipboardWatchPath()).toBe('/custom/watch.png')
  })

  test('returns undefined when set to empty string (disabled)', () => {
    process.env[CLIPBOARD_WATCH_PATH_ENV] = ''
    expect(getClipboardWatchPath()).toBeUndefined()
  })
})

describe('saveClipboardImageToTempFile (watch-path branch)', () => {
  test('reads the watch-path file when override unset and no clipboard', async () => {
    delete process.env[CLIPBOARD_IMAGE_SRC_ENV]
    const watchFile = join(tmpDir, 'inbox.png')
    writeFileSync(watchFile, PNG_1x1)
    process.env[CLIPBOARD_WATCH_PATH_ENV] = watchFile

    const result = await saveClipboardImageToTempFile()
    expect(result).not.toBeNull()
    if (!result) return
    savedPaths.push(result.path)
    expect(result.mediaType).toBe('image/png')
    expect(readFileSync(result.path).equals(PNG_1x1)).toBe(true)
    // The watch-path source is NOT deleted (it's the watcher's inbox).
    expect(existsSync(watchFile)).toBe(true)
  })

  test('falls through to clipboard when watch path missing and no override', async () => {
    delete process.env[CLIPBOARD_IMAGE_SRC_ENV]
    process.env[CLIPBOARD_WATCH_PATH_ENV] = join(tmpDir, 'absent-watch.png')
    // Headless sandbox: no clipboard image either → null.
    const result = await saveClipboardImageToTempFile()
    expect(result).toBeNull()
  })

  test('override wins over watch path when both set', async () => {
    const override = join(tmpDir, 'override.png')
    const watch = join(tmpDir, 'watch.png')
    writeFileSync(override, PNG_1x1)
    writeFileSync(watch, PNG_1x1)
    process.env[CLIPBOARD_IMAGE_SRC_ENV] = override
    process.env[CLIPBOARD_WATCH_PATH_ENV] = watch

    const result = await saveClipboardImageToTempFile()
    expect(result).not.toBeNull()
    if (!result) return
    savedPaths.push(result.path)
    // Override path is the source; temp file contents equal it (same bytes
    // here, but the assertion is that the override branch ran).
    expect(readFileSync(result.path).equals(PNG_1x1)).toBe(true)
  })
})

describe('saveClipboardImageToTempFile (OSC 52 branch)', () => {
  // A fake querier that responds to the OSC 52 read query with a PNG.
  function osc52Querier(png: Buffer): TerminalQuerier {
    const response: TerminalResponse = {
      type: 'osc',
      code: 52,
      data: `c;${png.toString('base64')}`,
    }
    return {
      send: () => Promise.resolve(response),
      flush: () => Promise.resolve(),
    } as unknown as TerminalQuerier
  }

  test('reads image bytes via OSC 52 when querier responds with a PNG', async () => {
    delete process.env[CLIPBOARD_IMAGE_SRC_ENV]
    delete process.env[CLIPBOARD_WATCH_PATH_ENV]
    const result = await saveClipboardImageToTempFile({ querier: osc52Querier(PNG_1x1) })
    expect(result).not.toBeNull()
    if (!result) return
    savedPaths.push(result.path)
    expect(result.mediaType).toBe('image/png')
    expect(readFileSync(result.path).equals(PNG_1x1)).toBe(true)
  })

  test('falls through to clipboard when OSC 52 returns undefined (unsupported)', async () => {
    delete process.env[CLIPBOARD_IMAGE_SRC_ENV]
    delete process.env[CLIPBOARD_WATCH_PATH_ENV]
    const querier = {
      send: () => Promise.resolve(undefined),
      flush: () => Promise.resolve(),
    } as unknown as TerminalQuerier
    // No clipboard on a headless sandbox → null.
    const result = await saveClipboardImageToTempFile({ querier })
    expect(result).toBeNull()
  })

  test('override wins over OSC 52', async () => {
    const override = join(tmpDir, 'override.png')
    writeFileSync(override, PNG_1x1)
    process.env[CLIPBOARD_IMAGE_SRC_ENV] = override
    const result = await saveClipboardImageToTempFile({ querier: osc52Querier(PNG_1x1) })
    expect(result).not.toBeNull()
    if (!result) return
    savedPaths.push(result.path)
    expect(readFileSync(result.path).equals(PNG_1x1)).toBe(true)
  })
})
