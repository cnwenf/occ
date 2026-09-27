import { describe, expect, test } from 'bun:test'
import { runOcc, tempDir } from './helpers'

/**
 * CC 2.1.283 — `--effort` CLI flag lenient parser (Gap-139a).
 *
 * The official 2.1.283 binary replaced the strict 2.1.218-era validation
 * (Commander InvalidArgumentError → exit 1 with "It must be one of: …") with
 * a warn-and-continue argParser (byte-verified from the linux-x64 ELF):
 *
 *   .argParser((S)=>{let{level:C,warning:G}=_5e(S);
 *     if(G!==void 0)process.stderr.write(`Warning: ${G}\n`);return C})
 *
 *   _5e: fhe (trim+lowercase+{med:"medium"} alias) → level
 *        ?? NNe ('ultracode' keyword) → keyword-as-level
 *        ?? { level: undefined,
 *             warning: "Unknown --effort value '<RAW>' — ignoring it and
 *                       using the default effort. Valid values:
 *                       low, medium, high, xhigh, max." }
 *
 * No upstream CHANGELOG entry exists for this change (silent upstream change;
 * Gap-58 precedent). Live A/B against the official 2.1.283 binary confirmed:
 * unknown values warn on stderr (raw case preserved, em dash) and the process
 * CONTINUES into the normal `-p` path; 'med' and 'ultracode' are accepted.
 *
 * These tests use the fast no-input `-p` path (empty stdin → immediate input
 * error) so no wire request is needed — the warning is emitted during
 * Commander parse, long before any model call.
 */

const EXACT_WARNING = (raw: string) =>
  `Warning: Unknown --effort value '${raw}' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.`

/** Pre-fix Commander hard-fail signatures — must never reappear. */
const COMMANDER_INVALID = "error: option '--effort <level>' argument"
const STALE_CHOICES_TEXT = 'It must be one of: low, medium, high, xhigh, max'

describe('version 2.1.283: --effort lenient CLI parser (Gap-139a)', () => {
  test('unknown value warns byte-exactly on stderr and continues (no hard fail)', async () => {
    const { dir, cleanup } = tempDir('occ-e2e-effort283-')
    try {
      const result = await runOcc(
        ['--effort', 'BoGuS', '-p'],
        { OCC_CWD: dir },
        60_000,
      )
      expect(result.stderr).toContain(EXACT_WARNING('BoGuS'))
      // The stale 2.1.218 behavior must be gone…
      expect(result.stderr).not.toContain(COMMANDER_INVALID)
      expect(result.stderr).not.toContain(STALE_CHOICES_TEXT)
      // …and the process must CONTINUE into the normal -p path (the fast
      // missing-input error), not exit at argument parsing. A Commander
      // parse failure exits 1 with "error: option …" on stderr; the
      // continued path never prints that.
      expect(result.durationMs).toBeLessThan(60_000)
    } finally {
      cleanup()
    }
  }, 120_000)

  test('unknown lowercase value keeps raw spelling in the warning', async () => {
    const { dir, cleanup } = tempDir('occ-e2e-effort283-')
    try {
      const result = await runOcc(['--effort', 'bogus', '-p'], { OCC_CWD: dir }, 60_000)
      expect(result.stderr).toContain(EXACT_WARNING('bogus'))
      expect(result.stderr).not.toContain(COMMANDER_INVALID)
    } finally {
      cleanup()
    }
  }, 120_000)

  test("accepted values emit no warning: level, alias 'med', keyword 'ultracode', case/trim", async () => {
    const { dir, cleanup } = tempDir('occ-e2e-effort283-')
    try {
      for (const value of ['high', 'med', 'ultracode', 'HIGH', 'xhigh']) {
        const result = await runOcc(['--effort', value, '-p'], { OCC_CWD: dir }, 60_000)
        expect(result.stderr).not.toContain('Unknown --effort value')
        expect(result.stderr).not.toContain(COMMANDER_INVALID)
        expect(result.stderr).not.toContain(STALE_CHOICES_TEXT)
      }
    } finally {
      cleanup()
    }
  }, 300_000)

  test('warn-and-continue lands on the same downstream path as a valid value', async () => {
    // Official semantics: the unknown value degrades to "no --effort given"
    // (level undefined) and the run proceeds. With empty stdin both runs must
    // therefore fail identically at the missing-input check — same exit code.
    const { dir, cleanup } = tempDir('occ-e2e-effort283-')
    try {
      const valid = await runOcc(['--effort', 'high', '-p'], { OCC_CWD: dir }, 60_000)
      const unknown = await runOcc(['--effort', 'BoGuS', '-p'], { OCC_CWD: dir }, 60_000)
      expect(valid.code).toBe(unknown.code)
      expect(valid.code).not.toBe(0)
    } finally {
      cleanup()
    }
  }, 180_000)
})
