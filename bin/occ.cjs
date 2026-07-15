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
 * BUN RESOLUTION ORDER
 *   1. `$BUN_PATH` env (power-user override)
 *   2. `bun` on PATH (the common case: `bun` is an OCC optionalDependency
 *      whose postinstall puts the real binary on PATH)
 *   3. `~/.bun/bin/bun` (user installed Bun via bun.sh installer)
 *   4. The optional-dep platform binary directly, e.g.
 *      `@oven/bun-linux-x64/bin/bun`. This path works EVEN WHEN npm was
 *      run with `--ignore-scripts` (so `bun`'s postinstall never ran and
 *      `bun` is not on PATH), because the `@oven/bun-*` packages ship the
 *      real ELF/Mach-O/PE binary in the tarball — no postinstall needed.
 *   5. The `bun` meta-package's `bin/bun.exe` (real only if its
 *      postinstall ran; redundant with #2 but harmless).
 *
 *   If none resolve, print install instructions and exit 1.
 */
'use strict'

const { existsSync } = require('node:fs')
const { spawn } = require('node:child_process')
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
 * The @oven/bun-<platform>-<arch> package(s) that match the current
 * process, ordered by preference (glibc before musl, non-baseline before
 * baseline). Each ships the real Bun binary at `bin/bun` (or `bin/bun.exe`
 * on Windows). List gleaned from the `bun` npm meta-package's
 * optionalDependencies (@oven 1.3.14).
 */
function platformPackages() {
  const p = process.platform
  const a = process.arch
  if (p === 'darwin' && a === 'x64') return ['@oven/bun-darwin-x64']
  if (p === 'darwin' && a === 'arm64') return ['@oven/bun-darwin-aarch64']
  if (p === 'linux' && a === 'x64')
    return [
      '@oven/bun-linux-x64',
      '@oven/bun-linux-x64-musl',
      '@oven/bun-linux-x64-baseline',
      '@oven/bun-linux-x64-musl-baseline',
    ]
  if (p === 'linux' && a === 'arm64')
    return ['@oven/bun-linux-aarch64', '@oven/bun-linux-aarch64-musl']
  if (p === 'win32' && a === 'x64') return ['@oven/bun-windows-x64']
  if (p === 'win32' && a === 'arm64') return ['@oven/bun-windows-aarch64']
  return []
}

/** Resolve a path inside a dependency package, or null if not installed. */
function resolveDepFile(spec) {
  try {
    return require.resolve(spec)
  } catch (_) {
    return null
  }
}

/** Ordered candidate Bun binaries. Bare 'bun' (PATH) validated by findOnPath. */
function bunCandidates() {
  const cands = []

  // 1. Power-user override.
  if (process.env.BUN_PATH && existsSync(process.env.BUN_PATH)) {
    cands.push(process.env.BUN_PATH)
  }

  // 2. `bun` on PATH — verified by findBun via an explicit PATH walk. If not
  //    present, fall through to #3/#4/#5 instead of returning a phantom
  //    candidate that would ENOENT at spawn and skip the better fallbacks.
  cands.push('bun')

  // 3. ~/.bun/bin/bun (bun.sh installer default location).
  const homeBun = path.join(os.homedir(), '.bun', 'bin', bunExeName)
  if (existsSync(homeBun)) cands.push(homeBun)

  // 4. Optional-dep platform binary (robust under --ignore-scripts).
  for (const pkg of platformPackages()) {
    const resolved = resolveDepFile(path.posix.join(pkg, 'bin', bunExeName))
    if (resolved && existsSync(resolved)) cands.push(resolved)
  }

  // 5. `bun` meta-package bin (real only if its postinstall ran).
  const metaBin = resolveDepFile('bun/bin/bun.exe')
  if (metaBin && existsSync(metaBin)) cands.push(metaBin)

  return cands
}

/**
 * Walk PATH for an executable named `name` (with Windows PATHEXT extensions
 * on win32). Returns the absolute path if found, else null. This is what
 * `bun:bundle`'s bare-candidate check needs — without it, returning 'bun'
 * unconditionally makes the shim skip #3/#4/#5 fallbacks when bun isn't on
 * PATH (the exact scenario the shim exists to handle).
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

function findBun() {
  const tried = []
  for (const c of bunCandidates()) {
    if (!c) continue
    tried.push(c)
    // Bare 'bun' is only usable if it's actually on PATH. Verify now so the
    // #3/#4/#5 fallbacks get a chance when it isn't — otherwise we'd return
    // a phantom 'bun' that ENOENTs at spawn, defeating the shim's purpose.
    if (c === 'bun') {
      if (findOnPath(bunExeName)) return { bin: c, viaShell: isWin, tried }
      continue
    }
    if (existsSync(c)) return { bin: c, viaShell: false, tried }
  }
  return { bin: null, viaShell: false, tried }
}

const { bin: bunBin, viaShell, tried } = findBun()

if (!bunBin) {
  console.error('')
  console.error('occ: Bun runtime not found.')
  console.error('')
  console.error('OCC requires Bun (>= 1.3.11) to run. Install it with one of:')
  console.error('  npm i -g bun')
  console.error('  curl -fsSL https://bun.sh/install | bash')
  console.error('Then run `occ` again.')
  console.error('')
  console.error('Tried: ' + tried.join(', '))
  process.exit(1)
}

const child = spawn(bunBin, [cliJs, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  shell: viaShell,
  windowsHide: false,
})

child.on('error', (err) => {
  if (err && err.code === 'ENOENT' && bunBin === 'bun') {
    console.error('')
    console.error('occ: `bun` is on PATH but not executable. Reinstall Bun:')
    console.error('  npm i -g bun')
    console.error('  curl -fsSL https://bun.sh/install | bash')
    process.exit(1)
  }
  console.error('occ: failed to launch bun:', err ? err.message : 'unknown error')
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
