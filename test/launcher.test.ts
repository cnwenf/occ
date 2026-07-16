import { describe, test, expect } from 'bun:test'
import { pathToFileURL } from 'node:url'

/**
 * Regression tests for the OCC launcher shim (bin/occ.cjs).
 *
 * The shim is a standalone CJS entry point — `npm i -g @cnwenf/occ` wires
 * the `occ` bin to it. These tests cover the pure resolution helpers that
 * pick a Bun binary on the host. The historical bug (OCC-6): on a glibc
 * host the shim picked a musl ELF (interpreter `/lib/ld-musl-x86_64.so.1`,
 * absent on glibc) and died with `failed to launch bun ... ENOENT`. The
 * fix restricts candidates to the host's libc (via `detectMusl`) and
 * probe-runs each before committing. These tests pin that behavior.
 *
 * The shim guards its spawn side behind `require.main === module`, so
 * requiring it is side-effect-free — we get the exported helpers without
 * the shim auto-launching a child.
 */
const shimPath = `${process.cwd()}/bin/occ.cjs`
// Clear the cache so each test sees a fresh module (some tests mutate the
// platform/arch to exercise different branches).
function loadShim(): Record<string, (...args: unknown[]) => unknown> {
  delete require.cache[shimPath]
  return require(pathToFileURL(shimPath).href)
}

describe('occ launcher: detectMusl', () => {
  test('returns a boolean for the current host', () => {
    const { detectMusl } = loadShim() as { detectMusl: () => boolean }
    const v = detectMusl()
    expect(typeof v === 'boolean').toBe(true)
  })

  test('returns false off-linux (platform guard)', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const { detectMusl } = loadShim() as { detectMusl: () => boolean }
      expect(detectMusl()).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })
})

describe('occ launcher: platformPackages libc filtering', () => {
  const origPlatform = process.platform
  const origArch = process.arch
  const origReport = process.report

  function withLinuxX64(musl: boolean, fn: () => void) {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    const fakeReport = {
      getReport: () =>
        musl
          ? { header: {} } // no glibcVersionRuntime → musl
          : { header: { glibcVersionRuntime: '2.36' } },
    }
    Object.defineProperty(process, 'report', { value: fakeReport, configurable: true })
    try {
      fn()
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
      Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
      Object.defineProperty(process, 'report', { value: origReport, configurable: true })
    }
  }

  test('glibc linux-x64 lists ONLY glibc variants (never musl)', () => {
    withLinuxX64(false, () => {
      const { platformPackages } = loadShim() as { platformPackages: () => string[] }
      const pkgs = platformPackages()
      expect(pkgs).toEqual(['@oven/bun-linux-x64', '@oven/bun-linux-x64-baseline'])
      // The whole point of the fix: musl must never appear on a glibc host.
      expect(pkgs.some((p) => p.includes('musl'))).toBe(false)
    })
  })

  test('musl linux-x64 lists ONLY musl variants (never glibc)', () => {
    withLinuxX64(true, () => {
      const { platformPackages } = loadShim() as { platformPackages: () => string[] }
      const pkgs = platformPackages()
      expect(pkgs).toEqual([
        '@oven/bun-linux-x64-musl',
        '@oven/bun-linux-x64-musl-baseline',
      ])
      expect(pkgs.some((p) => p.includes('musl'))).toBe(true)
      expect(pkgs.some((p) => !p.includes('musl'))).toBe(false)
    })
  })

  test('non-baseline is preferred before baseline', () => {
    withLinuxX64(false, () => {
      const { platformPackages } = loadShim() as { platformPackages: () => string[] }
      const pkgs = platformPackages()
      expect(pkgs[0]).toBe('@oven/bun-linux-x64') // non-baseline first
      expect(pkgs[1]).toBe('@oven/bun-linux-x64-baseline')
    })
  })

  test('unsupported platform returns empty list (no crash)', () => {
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    try {
      const { platformPackages } = loadShim() as { platformPackages: () => string[] }
      expect(platformPackages()).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
      Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
    }
  })
})

describe('occ launcher: probeRuns', () => {
  test('returns true for a binary that launches (node itself)', () => {
    const { probeRuns } = loadShim() as { probeRuns: (b: string) => boolean }
    // `node --version` exits 0 and exists wherever the shim runs.
    expect(probeRuns(process.execPath)).toBe(true)
  })

  test('returns false for a non-existent path (ENOENT)', () => {
    const { probeRuns } = loadShim() as { probeRuns: (b: string) => boolean }
    expect(probeRuns('/nonexistent/does-not-exist-bun-xyz')).toBe(false)
  })
})

describe('occ launcher: selectBun never picks a non-runnable binary', () => {
  test('a non-existent BUN_PATH is filtered out, never selected', () => {
    // The shim only pushes BUN_PATH if it existsSync; a missing path must be
    // dropped entirely (not picked, not even "tried"), and whatever selectBun
    // returns is either null or a binary that actually runs.
    process.env.BUN_PATH = '/no/such/bun'
    try {
      const { selectBun, probeRuns } = loadShim() as {
        selectBun: () => { bin: string | null; tried: string[] }
        probeRuns: (b: string) => boolean
      }
      const { bin, tried } = selectBun()
      expect(tried.includes('/no/such/bun')).toBe(false) // filtered by existsSync
      if (bin !== null) {
        expect(probeRuns(bin)).toBe(true)
      }
    } finally {
      delete process.env.BUN_PATH
    }
  })
})
