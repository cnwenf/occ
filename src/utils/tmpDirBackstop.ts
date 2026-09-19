import { tmpdir as osTmpdir } from 'os'

/**
 * Official `LPn` (byte-verified v277 @192,331,230 ≡ v278): maximum byte
 * length of the temp-root path so that per-uid temp dirs derived from it
 * still fit inside AF_UNIX socket path limits. Longer roots fall back to the
 * OS temp dir for child-process `$TMPDIR`.
 */
const MAX_TMP_ROOT_BYTES = 44

/**
 * Official `By()`: the temp root — `CLAUDE_CODE_TMPDIR` when set, otherwise
 * the OS temp dir. Deliberately NOT the per-uid `claude-<uid>` directory
 * (`getClaudeTempDir()`); the official backstop exports the root itself.
 */
export function getTmpRootDir(): string {
  const fromEnv = process.env.CLAUDE_CODE_TMPDIR
  if (fromEnv) {
    return fromEnv
  }
  return osTmpdir()
}

/**
 * Official `XZr()` — the 2.1.277 B6 fix value: the backstop directory
 * exported as `$TMPDIR` for Bash commands that run OUTSIDE the sandbox while
 * sandboxing is enabled (`{ [ -n "${TMPDIR:-}" ] || export TMPDIR=…; }`
 * prelude guard in bashProvider.buildExecCommand). Falls back to the OS temp
 * dir when `CLAUDE_CODE_TMPDIR` is too long for AF_UNIX-derived paths.
 *
 * Not memoized (matches the official per-call read) so env changes and tests
 * observe current values.
 */
export function getTmpDirBackstop(): string {
  const dir = getTmpRootDir()
  if (Buffer.byteLength(dir) <= MAX_TMP_ROOT_BYTES) {
    return dir
  }
  return osTmpdir()
}
