import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * CC 2.1.305 (R6 item 7) — remote-control spawn-mode saved-folder messages.
 *
 * Official v305 (byte-verified in /tmp/cc-diff-306/new305.txt):
 *  (a) the `w` toggle status line gains a persistence suffix —
 *      `je.logStatus(`Spawn mode: ${S==="worktree"?"worktree (new sessions
 *      get isolated git worktrees)":"same-dir (new sessions share the current
 *      directory)"}. Saved for this folder; w switches back.`)`
 *  (b) a startup line is emitted when the saved preference is in effect —
 *      `if(gt==="saved"&&nt)console.log(`Spawn mode: ${Re} (saved for this
 *      folder${process.stdin.isTTY===!0?"; press w to change":""})`)`
 *      where gt=spawnModeSource, nt=worktreeAvailable, Re=spawnMode.
 *
 * Why this is a source-pin test, not a runtime test: the whole surface sits
 * inside bridgeMain's giant closure behind `feature('DAEMON') &&
 * feature('BRIDGE_MODE')` — neither flag is in OCC's FEATURE_ALLOWLIST, so
 * the code path is dead in this build and cannot be invoked without a full
 * daemon + bridge session (no exported seam reaches the w-handler or the
 * startup precedence block). Source-string pinning has repo precedent
 * (e.g. sandboxGlobBracketsPatch304.test.ts, initReplBridgePolicyGlue286).
 * The pin catches regressions/removals of the byte-verified strings.
 */

const BRIDGE_MAIN_SRC = readFileSync(
  fileURLToPath(new URL('../bridgeMain.ts', import.meta.url)),
  'utf8',
)

describe('CC 2.1.305: spawn-mode w-toggle status gains the saved-folder suffix', () => {
  test('worktree arm ends with ". Saved for this folder; w switches back."', () => {
    expect(BRIDGE_MAIN_SRC).toContain(
      "'Spawn mode: worktree (new sessions get isolated git worktrees). Saved for this folder; w switches back.'",
    )
  })

  test('same-dir arm ends with ". Saved for this folder; w switches back."', () => {
    expect(BRIDGE_MAIN_SRC).toContain(
      "'Spawn mode: same-dir (new sessions share the current directory). Saved for this folder; w switches back.'",
    )
  })

  test('no pre-v305 status strings remain (suffix-less variants removed)', () => {
    // The v304 forms ended at "...worktrees)" / "...directory)" with no
    // persistence suffix — pin that the logStatus call site is the new one.
    expect(BRIDGE_MAIN_SRC).not.toMatch(
      /logStatus\(\s*newMode === 'worktree'\s*\? 'Spawn mode: worktree \(new sessions get isolated git worktrees\)'\s*:/,
    )
  })
})

describe('CC 2.1.305: startup line when the saved spawn-mode preference is in effect', () => {
  test('gated on spawnModeSource === "saved" && worktreeAvailable', () => {
    // Official `if(gt==="saved"&&nt)` — nt is worktreeAvailable (declared
    // from the git-repo/worktree capability probe above the precedence
    // block), so the saved preference only announces where it can apply.
    expect(BRIDGE_MAIN_SRC).toMatch(
      /if \(spawnModeSource === 'saved' && worktreeAvailable\) \{/,
    )
  })

  test('message shape matches the official template (TTY-gated hint)', () => {
    // Official: `Spawn mode: ${Re} (saved for this folder${process.stdin.
    // isTTY===!0?"; press w to change":""})`.
    expect(BRIDGE_MAIN_SRC).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: pinning the source template literal verbatim
      '`Spawn mode: ${spawnMode} (saved for this folder${process.stdin.isTTY === true ? \'; press w to change\' : \'\'})`',
    )
  })

  test('the startup log sits AFTER the spawn-mode precedence resolution', () => {
    // The gate_default fallback arm must precede the announcement so
    // spawnMode/spawnModeSource are final when the line prints.
    const precedenceIdx = BRIDGE_MAIN_SRC.indexOf("spawnModeSource = 'gate_default'")
    const announceIdx = BRIDGE_MAIN_SRC.indexOf("if (spawnModeSource === 'saved' && worktreeAvailable) {")
    expect(precedenceIdx).toBeGreaterThan(-1)
    expect(announceIdx).toBeGreaterThan(precedenceIdx)
  })
})
