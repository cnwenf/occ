import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { execSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT, runOcc } from './helpers'

/**
 * claude-code 2.1.248 hook-execution gaps e2e (Gap-108a / Gap-108d).
 *
 *   Gap-108a — hook invalid-JSON reporting rewrite (official `sIe`/`Nwt`/
 *              `vwt`/`Ewt`/`Mct`): malformed stdout is reported as a hook
 *              error with the real exit code + stderr; schema failures get
 *              the issue-formatted message + schema hint. Exit-2 outputs
 *              fall through to the blocking branches — the S24/2.1.214
 *              guarantee that a blocking hook cannot fail open by emitting
 *              malformed JSON — now via the official structure instead of
 *              the removed exit2BlockReason synthesis.
 *   Gap-108d — missing-script heuristic (official `i$t`): exit 2 + empty
 *              stdout + "no such file"/"can't open" stderr on Stop /
 *              SubagentStop / TaskCompleted / TeammateIdle (or plugin-owned
 *              UserPromptSubmit) is a non-blocking error with reinstall
 *              guidance, not a block.
 *
 * Layers: runtime probes of the real modules (`bun -e`), source-grep of the
 * executor structure, a headless `-p` blocking run (no model needed), and a
 * tmux REPL run (no model needed — the block precedes any API call).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`
const SESSION = 'occ-108-hook-block-test'

describe('Gap-108a parseHookOutput runtime probes (official sIe)', () => {
  test('malformed JSON object is a validation error with encoder advice', async () => {
    const script = `
import { parseHookOutput } from "${REPO_ROOT}/src/utils/hooks.ts";
const r = parseHookOutput('{"decision": bad json}');
console.log(JSON.stringify({ plainText: r.plainText, hasError: (r.validationError ?? '').includes('not valid JSON') }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.plainText).toBe('{"decision": bad json}')
    expect(out.hasError).toBe(true)
  })

  test('schema-failing valid JSON gets the vwt error and the Ewt schema hint', async () => {
    const script = `
import { parseHookOutput } from "${REPO_ROOT}/src/utils/hooks.ts";
const r = parseHookOutput('{"decision":"allow"}');
const e = r.validationError ?? '';
console.log(JSON.stringify({
  prefix: e.startsWith('Hook JSON output validation failed — '),
  hint: e.includes('Expected schema:'),
  permReq: e.includes('"for PermissionRequest"'),
  noSessionTitle: !e.includes('sessionTitle'),
}));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.prefix).toBe(true)
    expect(out.hint).toBe(true)
    expect(out.permReq).toBe(true)
    expect(out.noSessionTitle).toBe(true)
  })

  test('several empty JSON documents stay plain text', async () => {
    const script = `
import { parseHookOutput } from "${REPO_ROOT}/src/utils/hooks.ts";
const r = parseHookOutput('{}\\n{}');
console.log(JSON.stringify({ plainText: r.plainText === '{}\\n{}', validationError: r.validationError ?? null }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.plainText).toBe(true)
    expect(out.validationError).toBeNull()
  })

  test('first-line async announcement wins over trailing garbage', async () => {
    const script = `
import { parseHookOutput } from "${REPO_ROOT}/src/utils/hooks.ts";
const r = parseHookOutput('{"async":true}\\nnot json');
console.log(JSON.stringify({ json: r.json ?? null }));
`
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    )
    expect(out.json).toEqual({ async: true })
  })
})

describe('Gap-108a/108d executor structure (source-grep)', () => {
  test('validationError gate skips exit 2 at both command-hook call sites', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    const gates = src.match(/validationError && result\.status !== 2/g) ?? []
    // main REPL generator + aggregated runner
    expect(gates.length).toBeGreaterThanOrEqual(2)
    // Mct stderr wrap at the call sites (definition + >= 2 callers)
    const wraps = src.match(/wrapHookErrorWithStderr\(/g) ?? []
    expect(wraps.length).toBeGreaterThanOrEqual(3)
  })

  test('missing-script branch sits before the generic exit-2 block', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    const heuristic = src.indexOf('looksLikeMissingHookScript({')
    const missingMsg = src.indexOf('Hook script appears to be missing')
    expect(heuristic).toBeGreaterThan(-1)
    expect(missingMsg).toBeGreaterThan(heuristic)
    // reinstall guidance, both plugin and non-plugin variants (binary-exact;
    // raw source carries escaped backticks around /plugin)
    expect(src).toContain(
      "Run \\`/plugin\\` to reinstall '${pluginId}' or remove it from settings.",
    )
    expect(src).toContain(
      'If this is a plugin hook, check the plugin install (run /plugin).',
    )
  })

  test('async announcement failure carries the real status code', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    expect(src).toContain(
      'Announced async, then failed with status code ${result.status}',
    )
  })

  test('dead exit2BlockReason synthesis is gone', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    expect(src).not.toContain("from './hooks/hookExit2Block")
    expect(src).not.toContain('exit2BlockReason(')
    expect(
      existsSync(`${REPO_ROOT}/src/utils/hooks/hookExit2Block.ts`),
    ).toBe(false)
  })

  test('HTTP hook errors no longer carry the legacy prefix', async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/utils/hooks.ts`).text()
    expect(src).not.toContain('JSON validation failed: ')
  })
})

/** Seed a fresh HOME with onboarding + trust done and ONE user-level hook. */
function hookHome(root: string, projectDir: string, hookCommand: string): string {
  const home = join(root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  // Pre-approve the ambient API key (normalizeApiKeyForConfig keeps the
  // last 20 chars) so the run never stops at the "Detected a custom API
  // key" approval dialog.
  const approvedKeys = process.env.ANTHROPIC_API_KEY
    ? [process.env.ANTHROPIC_API_KEY.slice(-20)]
    : []
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: '2026-08-29T00:00:00.000Z',
      migrationVersion: 11,
      userID: 'occ-108-hook-e2e-0000000000000000000000000000000000000001',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.248',
      lastReleaseNotesSeen: '2.1.248',
      customApiKeyResponses: { approved: approvedKeys },
      projects: { [projectDir]: { hasTrustDialogAccepted: true } },
    }),
  )
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: hookCommand }] },
        ],
      },
    }),
  )
  return home
}

/** Parse stream-json stdout into typed events (tolerates non-JSON lines). */
function streamEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{'))
    .map(line => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null)
}

describe('S24 regression: exit-2 + malformed JSON still blocks (-p e2e)', () => {
  test('UserPromptSubmit exit 2 with invalid JSON never reaches the model', async () => {
    // Arrange: a hook that emits malformed JSON on stdout, a marker on
    // stderr, and exits 2. Pre-2.1.214 this shape could fail open; the S24
    // guarantee says it must block. Post-2.1.248 the block comes from the
    // official fall-through: validationError + status 2 skips the
    // non-throwing gate and reaches the generic exit-2 blocking branch.
    // The headless engine reports a blocked prompt as an empty success
    // result (no assistant turn), so the stream shape is the signal — no
    // model needed, this test runs offline.
    const root = mkdtempSync(join(tmpdir(), 'occ-108-s24-'))
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const home = hookHome(
      root,
      proj,
      `bash -c 'printf "{not json}"; echo deliberate-block-108 >&2; exit 2'`,
    )
    try {
      // Act
      const r = await runOcc(
        ['-p', 'hello', '--output-format', 'stream-json', '--verbose'],
        { HOME: home, OCC_CWD: proj },
      )
      const events = streamEvents(r.stdout)

      // Assert: init + result events, but the model was never queried
      expect(
        events.some(e => e.type === 'system' && e.subtype === 'init'),
      ).toBe(true)
      expect(events.some(e => e.type === 'assistant')).toBe(false)
      const result = events.find(e => e.type === 'result')
      expect(result).toBeDefined()
      expect(result?.num_turns).toBe(0)
      expect(result?.result).toBe('')
      // The missing-script heuristic (Gap-108d) must NOT fire for this shape
      expect(`${r.stdout}\n${r.stderr}`).not.toContain(
        'Treating as non-blocking',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.skipIf(!!process.env.CI)(
  'S24 regression: below exit 2 the prompt proceeds (-p e2e, live model)',
  () => {
    test('same hook shape at exit 1 is non-blocking', async () => {
      // Arrange: identical malformed JSON but exit 1 — the new Mct path
      // reports the validation error with the real exit code without
      // blocking, so the prompt must still reach the model. Headless `-p`
      // does not print the non-blocking error (attachment surface only),
      // so the live model answering is the observable non-block signal.
      const root = mkdtempSync(join(tmpdir(), 'occ-108-mct-'))
      const proj = join(root, 'proj')
      mkdirSync(proj, { recursive: true })
      const home = hookHome(
        root,
        proj,
        `bash -c 'printf "{not json}"; echo soft-fail-108 >&2; exit 1'`,
      )
      try {
        // Act
        const r = await runOcc(
          [
            '-p',
            'reply with just the word OK',
            '--output-format',
            'stream-json',
            '--verbose',
          ],
          { HOME: home, OCC_CWD: proj },
        )
        const events = streamEvents(r.stdout)

        // Assert: the model answered — the hook error did not block
        expect(events.some(e => e.type === 'assistant')).toBe(true)
        const result = events.find(e => e.type === 'result')
        expect(result).toBeDefined()
        expect(result?.subtype).toBe('success')
        expect(`${r.stdout}\n${r.stderr}`).not.toContain(
          'UserPromptSubmit operation blocked by hook',
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 90_000)
  },
)

/** Minimal tmux harness (same shape as goal-gate.e2e.test.ts). */
function tmux(args: string[]): string {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', timeout: 10_000 })
  } catch {
    return ''
  }
}
function startRepl(home: string, cwd: string) {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`)
  const envStr = Object.entries(process.env)
    .filter(([k]) => k.startsWith('ANTHROPIC'))
    .map(([k, v]) => `${k}='${v}'`)
    .join(' ')
  execSync(
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 -c '${cwd}' "env HOME='${home}' ${envStr} ${BIN}"`,
    { timeout: 5_000 },
  )
}
function killRepl() {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`)
}
function sendLine(text: string) {
  tmux(['send-keys', '-t', SESSION, text, 'Enter'])
}
function capturePane(): string {
  return tmux(['capture-pane', '-t', SESSION, '-p', '-S', '-'])
}
async function waitForText(substr: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (capturePane().toLowerCase().includes(substr.toLowerCase())) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

describe.skipIf(!!process.env.CI)('S24 regression in the interactive REPL (tmux e2e)', () => {
  test('exit-2 hook with invalid JSON blocks the REPL prompt', async () => {
    // Arrange: REPL home whose UserPromptSubmit hook exits 2 with malformed
    // JSON. No model needed — the block precedes any API call. The project
    // dir is pre-trusted in the seed so the REPL boots straight to the
    // prompt; the mode-pill footer ("shift+tab to cycle") marks ready.
    const root = mkdtempSync(join(tmpdir(), 'occ-108-repl-'))
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const home = hookHome(
      root,
      proj,
      `bash -c 'printf "{not json}"; echo repl-block-108 >&2; exit 2'`,
    )
    startRepl(home, proj)
    try {
      expect(await waitForText('shift+tab', 30_000)).toBe(true)

      // Act
      sendLine('hello 108')

      // Assert: the blocking error surfaces in the pane with the hook's
      // stderr (official exit-2 block shape: `[command]: stderr`)
      expect(await waitForText('repl-block-108', 15_000)).toBe(true)
      const pane = capturePane()
      expect(pane).toContain('UserPromptSubmit operation blocked by hook')
      expect(pane).not.toContain('Treating as non-blocking')
    } finally {
      killRepl()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
})
