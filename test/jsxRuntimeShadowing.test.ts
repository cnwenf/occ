/**
 * Source guard: no `.tsx`/`.jsx` file may declare a binding named exactly
 * `jsx`, `jsxs`, or `jsxDEV`.
 *
 * Why: with the automatic JSX runtime, every `<Foo />` element in a .tsx file
 * transpiles to a bare `jsx(Foo, ...)` identifier which the bundler then
 * resolves against scope. Bun's bundler resolves that identifier to an
 * innermost user binding of the same name instead of the react/jsx-runtime
 * import — the two symbols silently merge under one renamed slot:
 *
 *   source:  let jsx: React.ReactNode;
 *            setToolJSX({ jsx: <BashModeProgress ... /> })
 *   bundle:  let jsx434;
 *            setToolJSX({ jsx: /* @__PURE__ *\/ jsx434(BashModeProgress, ...) })
 *
 * At runtime `jsx434` is the still-undefined local, so the call throws
 * `TypeError: jsx434 is not a function`. When it happens on a fire-and-forget
 * submit path the rejection only reaches the global unhandledRejection debug
 * log — the feature dies silently (this killed every `!cmd` bash-mode submit;
 * OCC-89 / processBashCommand.tsx).
 *
 * The failure is bundle-time and name-based, so unit tests exercising source
 * modules directly cannot catch it. This guard scans the sources instead.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const SRC_ROOT = join(import.meta.dir, '..', 'src')
const FORBIDDEN = 'jsx|jsxs|jsxDEV'

// Binding-introducing shapes. Property shorthand inside object *literals*
// (`setToolJSX({ jsx, ... })`) is intentionally NOT matched — it is a value
// reference, not a binding — which is why the destructuring pattern requires
// a let/const/var prefix.
const BINDING_PATTERNS: ReadonlyArray<readonly [name: string, re: RegExp]> = [
  ['declaration', new RegExp(`(?:^|[^\\w$.])(?:let|const|var)\\s+(?:${FORBIDDEN})\\s*(?::[^=;]+)?\\s*[=;]`)],
  ['destructuring', new RegExp(`(?:^|[^\\w$.])(?:let|const|var)\\s*\\{[^}]*\\b(?:${FORBIDDEN})\\b\\s*[,}=]`)],
  ['arrow-param', new RegExp(`(?:^|[^\\w$.'"])(?:${FORBIDDEN})\\s*=>`)],
  ['typed-arrow-param', new RegExp(`(?:^|[^\\w$.])\\(\\s*(?:${FORBIDDEN})\\s*:[^)]*\\)\\s*=>`)],
  ['function-param', new RegExp(`function\\s*[\\w$]*\\s*\\(\\s*(?:${FORBIDDEN})\\s*[,):]`)],
]

interface Violation {
  file: string
  line: number
  kind: string
  text: string
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      collectSourceFiles(full, acc)
    } else if (/\.(tsx|jsx)$/.test(entry) && !/\.(test|spec)\.(tsx|jsx)$/.test(entry)) {
      acc.push(full)
    }
  }
  return acc
}

function findViolations(file: string): Violation[] {
  const violations: Violation[] = []
  const lines = readFileSync(file, 'utf8').split('\n')
  // Type-member shape: `name?: (jsx: T) => void;` inside an interface/type.
  // Param names in type positions are erased at compile time — no runtime
  // binding, no collision — so typed-arrow-param must not fire on them.
  const typeMemberLine = /^\s*(?:readonly\s+)?[\w$]+\??\s*:\s*\(/
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const trimmed = raw.trim()
    // Skip comment lines — the guard's own rationale comments mention `jsx`.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    for (const [kind, re] of BINDING_PATTERNS) {
      if (kind === 'typed-arrow-param' && typeMemberLine.test(raw)) continue
      if (re.test(raw)) {
        violations.push({
          file: relative(join(SRC_ROOT, '..'), file),
          line: i + 1,
          kind,
          text: trimmed.slice(0, 120),
        })
        break
      }
    }
  }
  return violations
}

describe('jsx-runtime shadowing guard', () => {
  test('no .tsx/.jsx source declares a binding named jsx/jsxs/jsxDEV', () => {
    const files = collectSourceFiles(SRC_ROOT)
    expect(files.length).toBeGreaterThan(100) // guard the guard: scan is real
    const violations = files.flatMap(findViolations)
    expect(
      violations,
      `Bindings named exactly jsx/jsxs/jsxDEV collide with the automatic JSX ` +
        `runtime import in Bun bundle output (feature dies silently at runtime). ` +
        `Rename the local binding. Violations:\n` +
        violations.map(v => `  ${v.file}:${v.line} [${v.kind}] ${v.text}`).join('\n'),
    ).toEqual([])
  })

  test('guard patterns catch the historical processBashCommand shape', () => {
    // Self-check on the regexes so a future loosening doesn't pass silently.
    const positives = [
      'let jsx: React.ReactNode;',
      'const jsx = terminalName ? <Text>a</Text> : null;',
      'var jsxs = x;',
      'const { jsx, other } = props;',
      '}).then(jsx => {',
      'const f = (jsx: React.ReactNode) => jsx;',
      'function render(jsx, opts) {}',
    ]
    const negatives = [
      'setToolJSX({ jsx: commandJsx, shouldHidePromptInput: false });',
      'const hintJsx = <Text>hi</Text>;',
      'foo.jsx;',
      'import { jsx as jsx_runtime } from "react/jsx-runtime";',
      'upgradeCall(onDone, context).then(jsx_0 => {',
      'onJsxChange(jsxNode);',
    ]
    for (const line of positives) {
      const matched = BINDING_PATTERNS.some(([, re]) => re.test(line))
      expect(matched, `expected pattern hit: ${line}`).toBe(true)
    }
    for (const line of negatives) {
      const matched = BINDING_PATTERNS.some(([, re]) => re.test(line))
      expect(matched, `unexpected pattern hit: ${line}`).toBe(false)
    }
  })
})
