#!/usr/bin/env node
/*
 * OCC launcher shim.
 *
 * WHY THIS EXISTS
 *   OCC ships a Bun-target bundle at dist/cli.js (built with
 *   `bun build --target bun`, shebang `#!/usr/bin/env bun`). When a user
 *   installs OCC via `npm i -g @cnwenf/occ` on a machine that has npm but
 *   NOT Bun, the kernel's shebang resolution fails with
 *   `/usr/bin/env: 'bun': No such file or directory` — so the `occ`
 *   command never even starts.
 *
 *   This shim is a Node script (npm guarantees Node is present), so it
 *   ALWAYS runs. It locates a Bun binary, then spawns
 *   `bun <package>/dist/cli.js <args…>`. If no Bun is available it prints
 *   a clear install instruction instead of a cryptic env error.
 *
 * WHY PROBE-RUN + LIBC DETECTION
 *   `bun` is an OCC *optional* dependency. npm does NOT link an optional
 *   dependency's `bin` into the global bin dir, so `bun` is NOT on PATH
 *   after `npm i -g @cnwenf/occ` — the shim must rely on the bundled
 *   `@oven/bun-*` platform binaries (and the `bun` meta-package's
 *   postinstall-selected `bin/bun.exe`).
 *
 *   The `bun` meta-package ships platform binaries for BOTH glibc and musl
 *   variants without an `os.libc` filter, so npm installs ALL of them on
 *   every Linux host. A musl ELF's interpreter is `/lib/ld-musl-x86_64.so.1`,
 *   which does NOT exist on a glibc host — spawning it fails with ENOENT.
 *   Older versions of this shim picked the first `existsSync`-true candidate
 *   in a fixed order (glibc, musl, …); when the glibc tarball's `bin/bun`
 *   was absent (the `bun` postinstall moves it) the musl binary was picked
 *   next, `existsSync`'d true, then ENOENT'd at spawn — `occ` died with
 *   `failed to launch bun`.
 *
 *   The fix mirrors the official `@anthropic-ai/claude-code` cli-wrapper:
 *   detect the host's libc (`process.report` glibcVersionRuntime), restrict
 *   candidates to the MATCHING libc only, and PROBE-RUN each candidate
 *   (`<bin> --version`) before committing — a present-but-unrunnable binary
 *   is skipped, not fatal.
 *
 * BUN RESOLUTION ORDER (each existing candidate is probe-run; first success wins)
 *   1. `$BUN_PATH` env (power-user override)
 *   2. `bun` on PATH (explicit PATH walk — npm does not link it for optional deps)
 *   3. `~/.bun/bin/bun` (user installed Bun via bun.sh installer)
 *   4. The `bun` meta-package's `bin/bun.exe` — the meta postinstall already
 *      detected the host and placed the correct (arch + libc) binary here.
 *   5. The `@oven/bun-<platform>-<arch>[-musl][-baseline]` platform binary
 *      matching the host's libc, non-baseline (AVX2) before baseline. This
 *      path works EVEN WHEN npm was run with `--ignore-scripts` (so the
 *      `bun` postinstall never ran and #4 is absent), because the `@oven-*`
 *      tarballs ship the real ELF/Mach-O/PE binary — no postinstall needed.
 *
 *   If none probe-run successfully, print install instructions and exit 1.
 */
'use strict'

const { existsSync } = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')

const pkgRoot = path.join(__dirname, '..')
const cliJs = path.join(pkgRoot, 'dist', 'cli.js')
const isWin = process.platform === 'win32'
const bunExeName = isWin ? 'bun.exe' : 'bun'

if (!existsSync(cliJs)) {
  console.error(
    'occ: dist/cli.js not found — the package install is incomplete or corrupt.',
  )
  console.error('Reinstall with: npm i -g @cnwenf/occ')
  process.exit(1)
}

/**
 * Detect a musl-libc Linux host the same way the official
 * `@anthropic-ai/claude-code` cli-wrapper does: Node's runtime report sets
 * `header.glibcVersionRuntime` only when running against glibc. Its absence
 * (on Alpine/musl, or when the report is unavailable) means musl.
 */
function detectMusl() {
  if (process.platform !== 'linux') return false
  try {
    const report =
      typeof process.report?.getReport === 'function'
        ? process.report.getReport()
        : null
    if (!report) return false
    return report.header?.glibcVersionRuntime === undefined
  } catch (_) {
    return false
  }
}

/**
 * The @oven/bun-<platform>-<arch> packages that match the CURRENT process,
 * restricted to the host's libc (glibc OR musl, never both) and ordered
 * non-baseline (AVX2, faster) before baseline (compatible fallback). Each
 * ships the real Bun binary at `bin/bun` (or `bin/bun.exe` on Windows).
 * List gleaned from the `bun` npm meta-package's optionalDependencies
 * (@oven 1.3.14).
 *
 * Restricting to one libc is the whole point: a glibc host must never
 * consider a musl ELF (its `/lib/ld-musl-x86_64.so.1` interpreter is absent
 * → ENOENT at spawn), and vice versa.
 */
function platformPackages() {
  const p = process.platform
  const a = process.arch
  const musl = detectMusl()
  if (p === 'darwin' && a === 'x64') return ['@oven/bun-darwin-x64']
  if (p === 'darwin' && a === 'arm64') return ['@oven/bun-darwin-aarch64']
  if (p === 'linux' && a === 'x64') {
    if (musl)
      return ['@oven/bun-linux-x64-musl', '@oven/bun-linux-x64-musl-baseline']
    return ['@oven/bun-linux-x64', '@oven/bun-linux-x64-baseline']
  }
  if (p === 'linux' && a === 'arm64') {
    if (musl) return ['@oven/bun-linux-aarch64-musl']
    return ['@oven/bun-linux-aarch64']
  }
  if (p === 'win32' && a === 'x64') return ['@oven/bun-windows-x64']
  if (p === 'win32' && a === 'arm64') return ['@oven/bun-windows-aarch64']
  return []
}

/**
 * Resolve a dependency PACKAGE DIRECTORY via its package.json (always
 * resolvable — `package.json` is exempt from `exports` restrictions), then
 * join the in-package relative path. This is the reliable way to locate a
 * bundled binary: `require.resolve('pkg/bin/bun')` fails when the binary
 * file is absent (postinstall hasn't created/moved it yet) or when the
 * package restricts subpath access — both false negatives that broke the
 * old shim. Returns null if the package or file is not present.
 */
function resolveDepFile(spec, relPath) {
  try {
    // Resolve the package DIRECTORY via its package.json (always resolvable
    // — `package.json` is exempt from `exports` restrictions). Resolving the
    // bare package name would fail for packages with no `main`/`exports`
    // (e.g. the `bun` meta-package and the `@oven/bun-*` binaries).
    const pkgJson = require.resolve(spec + '/package.json')
    const file = path.join(path.dirname(pkgJson), relPath)
    return existsSync(file) ? file : null
  } catch (_) {
    return null
  }
}

/**
 * Walk PATH for an executable named `name` (with Windows PATHEXT extensions
 * on win32). Returns the absolute path if found, else null.
 */
function findOnPath(name) {
  const pathVar = process.env.PATH || process.env.Path
  if (!pathVar) return null
  const sep = isWin ? ';' : ':'
  const exts = isWin
    ? (process.env.PATHEXT ? process.env.PATHEXT.split(';') : ['.exe', '.cmd', '.bat', ''])
    : ['']
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Ordered candidate Bun binaries. Each entry is an absolute path. Existence
 * is checked at build time; runnability is probe-verified later in selectBun().
 */
function bunCandidates() {
  const cands = []

  // 1. Power-user override.
  if (process.env.BUN_PATH && existsSync(process.env.BUN_PATH)) {
    cands.push(process.env.BUN_PATH)
  }

  // 2. `bun` on PATH — verified via an explicit PATH walk (npm does not
  //    link an optional dependency's bin globally, so this only matches when
  //    the user installed Bun separately).
  const pathBun = findOnPath(bunExeName)
  if (pathBun) cands.push(pathBun)

  // 3. ~/.bun/bin/bun (bun.sh installer default location).
  const homeBun = path.join(os.homedir(), '.bun', 'bin', bunExeName)
  if (existsSync(homeBun)) cands.push(homeBun)

  // 4. `bun` meta-package bin — postinstall-selected for this host. The
  //    meta package always names it `bin/bun.exe` regardless of platform.
  const metaBin = resolveDepFile('bun', path.posix.join('bin', 'bun.exe'))
  if (metaBin) cands.push(metaBin)

  // 5. Optional-dep platform binary (robust under --ignore-scripts); one
  //    libc only, non-baseline before baseline.
  for (const pkg of platformPackages()) {
    const resolved = resolveDepFile(pkg, path.posix.join('bin', bunExeName))
    if (resolved) cands.push(resolved)
  }

  return cands
}

/**
 * Probe-run a candidate Bun binary: `spawnSync(<bin>, ['--version'])` with a
 * short timeout. Returns true only if the binary actually launched AND
 * exited 0 — i.e. it is executable on THIS host. This is the signal that
 * `existsSync` cannot give: a present musl ELF on a glibc host `existsSync`'s
 * true but ENOENTs at spawn (missing `/lib/ld-musl-x86_64.so.1`); a
 * non-baseline binary needing a newer glibc ditto. Probing lets the shim
 * fall through to the next candidate instead of dying.
 */
function probeRuns(bin) {
  try {
    const r = spawnSync(bin, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
      shell: false,
    })
    if (r.error) return false
    return r.status === 0
  } catch (_) {
    return false
  }
}

function selectBun() {
  const tried = []
  for (const c of bunCandidates()) {
    if (!c) continue
    tried.push(c)
    if (probeRuns(c)) return { bin: c, viaShell: false, tried }
  }
  return { bin: null, viaShell: false, tried }
}

/**
 * Locate a working Bun binary and spawn `bun dist/cli.js <args…>`, inheriting
 * stdio so the child REPL/pipe owns the terminal. Exits the process with the
 * child's code/signal, or 1 on a launch error / no-binary-found.
 *
 * Hoisted into a function (and only invoked when this file is the entry point)
 * so the pure helpers above can be unit-tested via `require('./bin/occ.cjs')`
 * without the shim auto-spawning a child on import.
 */
function launch() {
  const { bin: bunBin, viaShell, tried } = selectBun()

  if (!bunBin) {
    console.error('')
    console.error('occ: Bun runtime not found.')
    console.error('')
    console.error('OCC requires Bun (>= 1.3.11) to run. Install it with one of:')
    console.error('  npm i -g bun')
    console.error('  curl -fsSL https://bun.sh/install | bash')
    console.error('Then run `occ` again.')
    console.error('')
    console.error('Tried: ' + (tried.length ? tried.join(', ') : '(no bundled bun found)'))
    process.exit(1)
  }

  const child = spawn(bunBin, [cliJs, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
    shell: viaShell,
    windowsHide: false,
  })

  child.on('error', (err) => {
    console.error('occ: failed to launch bun:', err ? err.message : 'unknown error')
    console.error('  binary: ' + bunBin)
    process.exit(1)
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      try {
        process.kill(process.pid, signal)
      } catch (_) {
        process.exit(1)
      }
      return
    }
    process.exit(code ?? 0)
  })
}

// Pure helpers exported for unit tests (see test/launcher.test.ts). When this
// file is the entry point (`occ` invoked on the CLI), run the launcher; when
// it is merely required, do nothing — no spawn side effect on import.
module.exports = { detectMusl, platformPackages, resolveDepFile, findOnPath, bunCandidates, probeRuns, selectBun }

if (require.main === module) {
  launch()
}
