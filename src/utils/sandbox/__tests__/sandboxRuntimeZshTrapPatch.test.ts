import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

/**
 * 2.1.276 ITEM K — zsh exit-code bug in @anthropic-ai/sandbox-runtime.
 *
 * The network-proxy wrapper emitted `trap "kill %1 %2 2>/dev/null; exit" EXIT`.
 * In bash a bare `exit` inside an EXIT trap preserves the status at trap
 * entry; in zsh it re-reads `$?`, which the preceding (successful) `kill`
 * just reset to 0 — so every failing sandboxed command exited 0 under zsh
 * (OCC's preferred shell). Official 2.1.276 fixed the vendored copy to
 * `trap 'rc=$?; kill %1 %2 2>/dev/null; exit $rc' EXIT`; the npm package
 * still ships the buggy form (even 0.0.76), so OCC patches it via
 * `bun patch` → patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch.
 *
 * These tests guard against a dependency bump (or `bun install` without
 * patchedDependencies) silently reverting the fix.
 */

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const DEP_FILE = join(
  REPO_ROOT,
  'node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js',
)
const PATCH_FILE = join(
  REPO_ROOT,
  'patches/@anthropic-ai%2Fsandbox-runtime@0.0.44.patch',
)

// Source-level literal as it appears in the patched .js file (single-quoted
// JS string with escaped inner quotes — byte-exact official v276 form).
const FIXED_TRAP_SOURCE = String.raw`'trap \'rc=$?; kill %1 %2 2>/dev/null; exit $rc\' EXIT'`
// The shell text the JS string evaluates to at runtime.
const FIXED_TRAP_RUNTIME = `trap 'rc=$?; kill %1 %2 2>/dev/null; exit $rc' EXIT`
const BUGGY_TRAP = 'trap "kill %1 %2 2>/dev/null; exit" EXIT'

const ZSH_PATH = '/usr/bin/zsh'
const hasZsh = existsSync(ZSH_PATH)

describe('2.1.276 ITEM K — sandbox-runtime zsh EXIT trap patch', () => {
  test('installed dependency contains the fixed v276 trap string', () => {
    // Arrange
    const source = readFileSync(DEP_FILE, 'utf8')

    // Act & Assert: the emitted shell text is the official 2.1.276 form
    expect(source).toContain('rc=$?; kill %1 %2 2>/dev/null; exit $rc')
    expect(source).toContain(FIXED_TRAP_SOURCE)
  })

  test('installed dependency no longer contains the buggy double-quoted trap', () => {
    // Arrange
    const source = readFileSync(DEP_FILE, 'utf8')

    // Act & Assert
    expect(source).not.toContain(BUGGY_TRAP)
    expect(source).not.toContain('"kill %1 %2 2>/dev/null; exit"')
  })

  test('patch is registered in package.json and the patch file exists', () => {
    // Arrange
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { patchedDependencies?: Record<string, string> }

    // Act
    const entry = pkg.patchedDependencies?.[
      '@anthropic-ai/sandbox-runtime@0.0.44'
    ]

    // Assert
    expect(entry).toBeDefined()
    expect(existsSync(join(REPO_ROOT, entry ?? ''))).toBe(true)
    expect(existsSync(PATCH_FILE)).toBe(true)
  })

  test.skipIf(!hasZsh)(
    'zsh semantics: fixed trap preserves the failing command exit code (42)',
    () => {
      // Arrange — faithful repro of the wrapper's socat/trap prologue
      const script = `sleep 30 & sleep 30 & ${FIXED_TRAP_RUNTIME}; eval "exit 42"`

      // Act
      const result = Bun.spawnSync([ZSH_PATH, '-c', script])

      // Assert
      expect(result.exitCode).toBe(42)
    },
  )

  test.skipIf(!hasZsh)(
    'zsh semantics: pre-fix buggy trap masks the failure as exit 0',
    () => {
      // Arrange — the exact pre-2.1.276 wrapper trap (root-cause repro)
      const script = `sleep 30 & sleep 30 & ${BUGGY_TRAP}; eval "exit 42"`

      // Act
      const result = Bun.spawnSync([ZSH_PATH, '-c', script])

      // Assert: buggy form loses the exit code under zsh
      expect(result.exitCode).toBe(0)
    },
  )
})
