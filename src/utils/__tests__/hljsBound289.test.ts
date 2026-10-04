/**
 * Gap-289 #2 — "Fixed the terminal freezing on short code blocks with many
 * unclosed `<script>` tags or deeply nested `${` substitutions".
 *
 * Official v289 (s289.txt @17551578, absent from v288) installs a budgeted
 * guard around the hljs emitter at the hljs-manager core-load site
 * (`let n=e.loadCore();Se(n);` @17553789):
 *   HighlightBoundError ("highlighting this text takes more work than its
 *   length allows"), depth cap 32, fanout cap 64,
 *   budget = 4096 + len*(24 + 3*fanout), depth²-charged addText/
 *   __addSublanguage, uncapped-array-fanout → Infinity guard, and a renderer
 *   failure memo (`catch{return e.lang=null,…plain…}` @37062551).
 *
 * Symbol map (official → OCC):
 *   C  = HighlightBoundError        b  = charge
 *   ee = countNewlines              he/me/pe/we/Le/xe = MAX_HEIGHT/MAX_FANOUT/
 *        BASE_BUDGET/CHAR_COST/FANOUT_COST/CTOR_COST
 *   te = boundedEmitter             ne = isUnboundedEmitterClass
 *   re = grammarFanout              oe = makeBudgetFn
 *   ie = budgetPlugin               z/Se = installHighlightBounds
 *
 * The stock xml grammar's `<script>` rule carries
 * `subLanguage: ['javascript','handlebars']` and handlebars carries
 * `subLanguage: 'xml'` — with N unclosed `<script>` tags each cascade level
 * re-highlights the remaining buffer, ~1.5× work per tag: exponential in tag
 * count, independent of block size (doc cluster-c §1e). OCC pre-fix freezes
 * identically: n=24 through the exact production path (markdown.ts →
 * cli-highlight → highlight.js 11.11.1) is SIGKILLed at 12 s.
 *
 * (a) runs the production path in a CHILD process with a hard kill: the
 * freeze is synchronous CPU work that no in-process timer can interrupt, so a
 * plain Bun test timeout would hang the whole runner instead of failing fast.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import stripAnsi from 'strip-ansi'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const PROBE_KILL_MS = 12_000
const ADVERSARIAL_TAGS = 24

const probeDir = mkdtempSync(join(tmpdir(), 'occ-hljsbound289-'))
afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true })
})

/**
 * Runs the exact OCC production highlight path (getCliHighlightPromise +
 * applyMarkdown, i.e. what Markdown.tsx does per assistant message) in a
 * child process, killed with SIGKILL after PROBE_KILL_MS. Returns the parsed
 * RESULT payload; throws (via test failure) when the child was killed or
 * produced no result — that is the pre-fix freeze signature.
 */
async function runProductionProbe(markdown: string): Promise<{
  ms: number
  out: string
}> {
  const scriptPath = join(probeDir, `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(
    scriptPath,
    `const t0 = Date.now()
const { getCliHighlightPromise } = await import(${JSON.stringify(join(REPO_ROOT, 'src/utils/cliHighlight.ts'))})
const { applyMarkdown } = await import(${JSON.stringify(join(REPO_ROOT, 'src/utils/markdown.ts'))})
const hl = await getCliHighlightPromise()
if (!hl) { console.log('NO_HL'); process.exit(2) }
const out = applyMarkdown(${JSON.stringify(markdown)}, 'dark', hl)
console.log('RESULT' + JSON.stringify({ ms: Date.now() - t0, out }))
`,
  )
  const proc = Bun.spawn(['bun', scriptPath], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    // Mirror the real REPL: chalk emits ANSI only when colors are on, and a
    // piped child defaults to chalk level 0.
    env: { ...process.env, FORCE_COLOR: '1' },
  })
  const killer = setTimeout(() => proc.kill(9), PROBE_KILL_MS)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(killer)
  const marker = stdout.lastIndexOf('RESULT')
  expect(
    marker >= 0 && exitCode === 0,
    `production highlight path did not complete (exit=${exitCode}, killed after ${PROBE_KILL_MS}ms = pre-fix freeze). stderr: ${stderr.slice(0, 400)}`,
  ).toBeTrue()
  return JSON.parse(stdout.slice(marker + 'RESULT'.length)) as {
    ms: number
    out: string
  }
}

async function loadBoundModule(): Promise<
  typeof import('../hljsBound.ts')
> {
  return await import('../hljsBound.ts')
}

type HljsLike = {
  highlight(code: string, opts?: { language?: string; ignoreIllegals?: boolean }): { value: string }
  highlightAuto(code: string, subset?: string[]): unknown
  getLanguage(name: string): unknown
  listLanguages(): string[]
}

async function freshHljs(languages: string[]): Promise<HljsLike> {
  const full = (await import('highlight.js')).default as unknown as {
    newInstance: () => HljsLike
  }
  const inst = full.newInstance()
  for (const name of languages) {
    const mod = (await import(`highlight.js/lib/languages/${name}`)) as {
      default: unknown
    }
    ;(inst as unknown as { registerLanguage: (n: string, g: unknown) => void })
      .registerLanguage(name, mod.default)
  }
  return inst
}

// The cascade needs xml + the grammars its <script> rule fans out to.
const CASCADE_LANGUAGES = ['xml', 'javascript', 'handlebars']

describe('289 #2 — production path: adversarial fence completes (falls back plain)', () => {
  test(
    `short html fence with ${ADVERSARIAL_TAGS} unclosed <script> tags completes instead of freezing`,
    async () => {
      const adversarial = '```html\n' + '<script>'.repeat(ADVERSARIAL_TAGS) + '\n```'
      const result = await runProductionProbe(adversarial)
      // Official behavior: budget blown → plain text (no ANSI), and fast.
      expect(stripAnsi(result.out)).toBe('<script>'.repeat(ADVERSARIAL_TAGS))
      expect(result.ms).toBeLessThan(PROBE_KILL_MS)
    },
    30_000,
  )

  test(
    'normal js fence still renders highlighted (ANSI) through the production path',
    async () => {
      const result = await runProductionProbe('```js\nconst x = 1\n```')
      expect(stripAnsi(result.out)).toBe('const x = 1')
      // cli-highlight chalk-themes the hljs output — highlighted ≠ raw.
      expect(result.out).not.toBe(stripAnsi(result.out))
    },
    30_000,
  )
})

describe('289 #2 — production path: deeply nested ${ completes', () => {
  test(
    '5000-level nested ${ javascript fence completes through applyMarkdown',
    async () => {
      const t0 = Date.now()
      const { getCliHighlightPromise } = await import('../cliHighlight.ts')
      const { applyMarkdown } = await import('../markdown.ts')
      const hl = await getCliHighlightPromise()
      expect(hl).not.toBeNull()
      const nested = '`${'.repeat(5000)
      const out = applyMarkdown('```javascript\n' + nested + '\n```', 'dark', hl)
      // Bounded post-fix (plain fallback or highlighted); linear pre-fix.
      // Either way: completes, preserves the text, no hang, no throw.
      expect(stripAnsi(out).startsWith('`${`${')).toBeTrue()
      expect(Date.now() - t0).toBeLessThan(10_000)
    },
    25_000,
  )
})

describe('289 #2 — hljsBound wrapper unit tests', () => {
  test('exports the official budget constants verbatim', async () => {
    const mod = await loadBoundModule()
    expect(mod.MAX_HEIGHT).toBe(32) // official he
    expect(mod.MAX_FANOUT).toBe(64) // official me
    expect(mod.BASE_BUDGET).toBe(4096) // official pe
    expect(mod.CHAR_COST).toBe(24) // official we
    expect(mod.FANOUT_COST).toBe(3) // official Le
    expect(mod.CTOR_COST).toBe(16) // official xe
  })

  test('HighlightBoundError carries the official name + message', async () => {
    const { HighlightBoundError } = await loadBoundModule()
    const err = new HighlightBoundError()
    expect(err.name).toBe('HighlightBoundError')
    expect(err.message).toBe(
      'highlighting this text takes more work than its length allows',
    )
    expect(err instanceof Error).toBeTrue()
  })

  test('exponential grammar work (unclosed <script> cascade) trips HighlightBoundError', async () => {
    const { HighlightBoundError, installHighlightBounds } =
      await loadBoundModule()
    const inst = await freshHljs(CASCADE_LANGUAGES)
    installHighlightBounds(inst)
    let thrown: unknown = null
    try {
      inst.highlight('<script>'.repeat(ADVERSARIAL_TAGS), {
        language: 'xml',
        ignoreIllegals: true,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown instanceof HighlightBoundError).toBeTrue()
  })

  test('installHighlightBounds is idempotent (official ne/isBounded guard)', async () => {
    const { installHighlightBounds } = await loadBoundModule()
    const inst = await freshHljs(CASCADE_LANGUAGES)
    installHighlightBounds(inst)
    const first = inst.highlight('const x = 1', {
      language: 'javascript',
      ignoreIllegals: true,
    }).value
    // Second install must be a no-op, not a double-wrap.
    installHighlightBounds(inst)
    const second = inst.highlight('const x = 1', {
      language: 'javascript',
      ignoreIllegals: true,
    }).value
    expect(second).toBe(first)
  })

  test('normal highlighting is byte-identical bounded vs unbounded (js, bash, json)', async () => {
    const { installHighlightBounds } = await loadBoundModule()
    const languages = ['javascript', 'bash', 'json', 'xml']
    const unbounded = await freshHljs(languages)
    const bounded = await freshHljs(languages)
    installHighlightBounds(bounded)
    const samples: Array<[string, string]> = [
      ['javascript', 'const x = 1\nfunction f(a, b) { return a + b }'],
      ['bash', 'echo "hi" | grep h\nexport FOO=bar'],
      ['json', '{"a": [1, 2.5, true, null], "b": {"c": "d"}}'],
      ['xml', '<div class="x"><p>hello &amp; bye</p></div>'],
    ]
    for (const [language, code] of samples) {
      const before = unbounded.highlight(code, {
        language,
        ignoreIllegals: true,
      }).value
      const after = bounded.highlight(code, {
        language,
        ignoreIllegals: true,
      }).value
      expect(after).toBe(before)
      expect(after).toContain('hljs-')
    }
  })

  test('deeply nested ${ on a bounded instance completes (value or HighlightBoundError only)', async () => {
    const { HighlightBoundError, installHighlightBounds } =
      await loadBoundModule()
    const inst = await freshHljs(['javascript'])
    installHighlightBounds(inst)
    const t0 = Date.now()
    let threw: unknown = null
    try {
      inst.highlight('`${'.repeat(5000), {
        language: 'javascript',
        ignoreIllegals: true,
      })
    } catch (err) {
      threw = err
    }
    // Depth cap (32) / depth² charges may legitimately trip the bound; any
    // OTHER error (or a hang) is a failure.
    expect(threw === null || threw instanceof HighlightBoundError).toBeTrue()
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})
