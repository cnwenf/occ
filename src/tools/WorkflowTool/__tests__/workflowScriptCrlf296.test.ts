// Repo-convention MACRO polyfill (must run before scriptLoader.js is loaded).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type LoadedScript,
  loadScript,
  loadScriptFromSource,
} from '../scriptLoader.js'

/**
 * CC 2.1.296 (#043): "Workflows: scripts saved with Windows (CRLF) line
 * endings are now accepted" (cl-296).
 *
 * Official 296 script sanitizer (binary `I3n`):
 *   `I3n(e)=Lpe(gf(e).replace(/\r\n/g,"\n").split("\n").map(Rn).join("\n"),R3n)`
 * — `\r\n` → `\n` normalization up front, before meta/body parsing.
 *
 * Minimal-port deviation (documented in scriptLoader.ts): OCC adopts ONLY
 * the CRLF→LF normalization — not the per-line control-char strip (`Rn`) or
 * the 10240-char cap (`R3n`), which belong to the official's separate
 * string-field sanitizer family and are not part of the changelog item.
 *
 * Red-test baseline (OCC before this change): a CRLF-saved script failed the
 * `export const meta` first-statement match on the trailing `\r`s
 * (WorkflowScriptError), so Windows-authored workflows could not load.
 */

const LF_SCRIPT =
  "export const meta = { name: 'crlf-296', description: 'CRLF acceptance' }\nexport default async () => 1\n"
const CRLF_SCRIPT = LF_SCRIPT.replace(/\n/g, '\r\n')

const tempRoots: string[] = []

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

describe('2.1.296 #043 — loadScriptFromSource CRLF acceptance', () => {
  test('a CRLF script parses where the LF script parses (meta + body identical)', () => {
    // Arrange
    const expected = loadScriptFromSource(LF_SCRIPT)

    // Act
    const actual = loadScriptFromSource(CRLF_SCRIPT)

    // Assert
    expect(actual.meta).toEqual(expected.meta)
    expect(actual.meta.name).toBe('crlf-296')
    expect(actual.body).toBe(expected.body)
    expect(actual.hasDefaultExport).toBe(true)
  })

  test('the returned source is normalized — no \\r survives (I3n replace)', () => {
    // Arrange / Act
    const loaded: LoadedScript = loadScriptFromSource(CRLF_SCRIPT)

    // Assert
    expect(loaded.source).not.toContain('\r')
    expect(loaded.source).toBe(LF_SCRIPT)
  })

  test('an LF-only script passes through byte-identical (normalization is a no-op)', () => {
    // Arrange / Act
    const loaded = loadScriptFromSource(LF_SCRIPT)

    // Assert
    expect(loaded.source).toBe(LF_SCRIPT)
  })

  test('mixed line endings normalize only the CRLF pairs', () => {
    // Arrange — one CRLF line, one LF line.
    const mixed =
      "export const meta = { name: 'mixed-296', description: 'd' }\r\nexport default async () => 2\n"

    // Act
    const loaded = loadScriptFromSource(mixed)

    // Assert
    expect(loaded.source).toBe(mixed.replace(/\r\n/g, '\n'))
    expect(loaded.meta.name).toBe('mixed-296')
  })

  test('a lone \\r (classic-Mac ending) is NOT normalized — official replace is /\\r\\n/g only', () => {
    // Arrange — `\r`-only endings are outside the official I3n contract; the
    // minimal port must leave them untouched (no over-normalization).
    const crOnly =
      "export const meta = { name: 'cr', description: 'd' }\rexport default async () => 1\r"

    // Act
    const loaded = loadScriptFromSource(crOnly)

    // Assert — the lone \r characters survive verbatim in the returned source.
    expect(loaded.source).toBe(crOnly)
    expect(loaded.source).toContain('\r')
  })
})

describe('2.1.296 #043 — loadScript (file path) CRLF acceptance', () => {
  test('a CRLF-saved workflow file loads from disk', () => {
    // Arrange
    const dir = makeDir('occ-crlf296-')
    const scriptPath = join(dir, 'workflow-crlf.js')
    writeFileSync(scriptPath, CRLF_SCRIPT, 'utf8')

    // Act
    const loaded = loadScript(scriptPath)

    // Assert
    expect(loaded.meta.name).toBe('crlf-296')
    expect(loaded.source).toBe(LF_SCRIPT)
    expect(loaded.scriptPath).toBe(scriptPath)
  })
})
