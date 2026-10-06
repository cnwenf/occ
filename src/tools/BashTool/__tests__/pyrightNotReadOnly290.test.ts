import { describe, expect, test } from 'bun:test'
import { isCommandSafeViaFlagParsing } from '../readOnlyValidation'

/**
 * Gap-research-291 Cluster A #4 — "pyright is no longer read-only" (official
 * 2.1.290).
 *
 * Byte-verified against the official 2.1.289/290/291 linux-x64 ELFs (see
 * docs/gap-research-291/verify-290-snippets-report.md ITEM #4 and
 * docs/gap-research-291/cluster-a-bash-permissions.md #4):
 *   - 289 kept a standalone read-only CommandConfig
 *     `AVo={pyright:{respectsDoubleDash:!1,safeFlags:{"--outputjson":"none",
 *     "--pythonversion":"string",...,"--version":"none"},
 *     additionalCommandIsDangerousCallback:(e,n)=>n.some(r=>r==="--watch"||
 *     r==="-w")}}` (byte-verified @cc289 204054681) and spread it into the
 *     read-only command-table assembly (@209993049: `...AVo,...gbn,`).
 *   - 290 removed the pyright entry ENTIRELY from that table: the assembly now
 *     spreads a single symbol (@213184268: `...CTn,`, where `CTn` = `gbn`
 *     renamed = `{"docker logs":{...},"docker inspect":{...}}`). Motive prose
 *     new in 290 (@219331639/@219346683): pyright "runs python3 there, which
 *     imports from that directory first" -> an interpreter started in cwd is
 *     never read-only.
 *   - Grep-hit correction (supersedes the earlier "Fig completion spec"
 *     reading): 289 had TWO `pyright:{` byte hits -- one real CommandConfig
 *     (`AVo`), one `copyright:{` HTML-entity-table FALSE POSITIVE
 *     (`co` + `pyright:{` + `regex:/&(copy|#169)...` in the named-entity decode
 *     map). 290/291 retain only that false positive, so the REAL CommandConfig
 *     count went 1 -> 0. The genuine Fig completion spec is a DIFFERENT literal
 *     (`{name:"pyright",description:"Type checker for Python"}` @213481051),
 *     present in all three versions -- it was never the second `pyright:{` hit.
 *     OCC likewise keeps its own completion spec at src/utils/bash/specs/
 *     pyright.ts; only the read-only auto-allow entry is deleted here.
 *
 * Rationale: `pyright --createstub` / `--watch` can write files / run long-lived
 * (and pyright spawns python3 in cwd), so 290 de-lists the whole command rather
 * than keep patching its flag callback. After de-listing, `pyright ...` no
 * longer matches the read-only table -> falls through to `no-rule-match` ask (an
 * explicit `Bash(pyright:*)` allow rule still works -- the rule channel is
 * unaffected by de-listing).
 *
 * `isCommandSafeViaFlagParsing` is the exact surface that changes: it consults
 * COMMAND_ALLOWLIST membership, which no longer contains `pyright` after this
 * port. `docker logs` / `docker inspect` live in the SEPARATE
 * DOCKER_READ_ONLY_COMMANDS spread (the `CTn` equivalent) and must be
 * unaffected. (Note: `docker ps` / `docker images` are string entries in
 * EXTERNAL_READONLY_COMMANDS, a different mechanism, and were never
 * flag-parsing-safe -- not asserted here.)
 */

// --- 290 NEW: pyright de-listed — every form must now ASK (not auto-allow) ---
describe('2.1.290 #4: pyright is no longer read-only (ASK)', () => {
  test('pyright --outputjson -> ASK (was auto-allowed under 289)', () => {
    // RED baseline: currently true (pyright in COMMAND_ALLOWLIST via spread).
    // After de-listing there is no config for `pyright`, so flag parsing fails.
    expect(isCommandSafeViaFlagParsing('pyright --outputjson')).toBe(false)
  })

  test('pyright --version -> ASK (official de-lists the whole command, even --version)', () => {
    expect(isCommandSafeViaFlagParsing('pyright --version')).toBe(false)
  })

  test('pyright (bare) -> ASK (no config -> not flag-parsing-safe)', () => {
    expect(isCommandSafeViaFlagParsing('pyright')).toBe(false)
  })

  test('pyright --watch -> ASK (regression: previously caught by the watch callback, now by de-listing)', () => {
    expect(isCommandSafeViaFlagParsing('pyright --watch')).toBe(false)
  })

  test('pyright -- --createstub os -> ASK (regression: previously caught by respectsDoubleDash:false, now by de-listing)', () => {
    expect(isCommandSafeViaFlagParsing('pyright -- --createstub os')).toBe(
      false,
    )
  })
})

// --- Regression guards: the docker read-only entries (CTn equivalent) survive ---
describe('2.1.290 #4: docker read-only entries unaffected', () => {
  test('docker logs x -> still ALLOW (DOCKER_READ_ONLY_COMMANDS is a separate spread)', () => {
    expect(isCommandSafeViaFlagParsing('docker logs x')).toBe(true)
  })

  test('docker inspect x -> still ALLOW', () => {
    expect(isCommandSafeViaFlagParsing('docker inspect x')).toBe(true)
  })
})
