import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { getPlatform } from './platform.js'

// Cache states:
// undefined = not yet loaded (need to check disk)
// null = checked disk, no files exist (don't check again)
// string = loaded and cached (use cached value)
let sessionEnvScript: string | null | undefined

/**
 * SEC-2 hardening: the session id becomes a path segment under
 * `<config>/session-env/` and the directory is created recursively, so a
 * hostile or corrupt id (e.g. `../../evil`, `a/b`) must never be
 * interpolated verbatim — `mkdir` would otherwise escape the session-env
 * root. Only `[A-Za-z0-9_-]` survives; every other character (including
 * `.`, `/`, `\`, NUL) is replaced with `_`. Canonical session ids are uuids
 * (hex digits + dashes), so the on-disk layout for legitimate ids is
 * unchanged. An id that sanitizes to the empty string maps to `_`.
 */
const UNSAFE_SEGMENT_CHARACTERS = /[^A-Za-z0-9_-]/g
const SANITIZED_EMPTY_SEGMENT = '_'

export function sanitizeSessionIdSegment(sessionId: string): string {
  const sanitized = sessionId.replace(
    UNSAFE_SEGMENT_CHARACTERS,
    SANITIZED_EMPTY_SEGMENT,
  )
  return sanitized === '' ? SANITIZED_EMPTY_SEGMENT : sanitized
}

/**
 * CC 2.1.295 (Item 4): `sessionId` overrides the global getSessionId() key.
 * Resume/branch flows fire SessionStart hooks BEFORE switchSession(), so the
 * hook's own input session_id (the session being resumed INTO) must key the
 * env dir — otherwise CLAUDE_ENV_FILE writes land in the OLD session's dir
 * and never reach Bash after the switch.
 *
 * The id is passed through `sanitizeSessionIdSegment` (SEC-2) before it
 * becomes a path segment.
 */
export async function getSessionEnvDirPath(
  sessionId?: string,
): Promise<string> {
  const sessionEnvDir = join(
    getClaudeConfigHomeDir(),
    'session-env',
    sanitizeSessionIdSegment(sessionId ?? getSessionId()),
  )
  await mkdir(sessionEnvDir, { recursive: true })
  return sessionEnvDir
}

export async function getHookEnvFilePath(
  hookEvent: 'Setup' | 'SessionStart' | 'CwdChanged' | 'FileChanged',
  hookIndex: number,
  sessionId?: string,
): Promise<string> {
  const prefix = hookEvent.toLowerCase()
  return join(
    await getSessionEnvDirPath(sessionId),
    `${prefix}-hook-${hookIndex}.sh`,
  )
}

export async function clearCwdEnvFiles(): Promise<void> {
  try {
    const dir = await getSessionEnvDirPath()
    const files = await readdir(dir)
    await Promise.all(
      files
        .filter(
          f =>
            (f.startsWith('filechanged-hook-') ||
              f.startsWith('cwdchanged-hook-')) &&
            HOOK_ENV_REGEX.test(f),
        )
        .map(f => writeFile(join(dir, f), '')),
    )
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(`Failed to clear cwd env files: ${errorMessage(e)}`)
    }
  }
}

export function invalidateSessionEnvCache(): void {
  logForDebugging('Invalidating session environment cache')
  sessionEnvScript = undefined
}

export async function getSessionEnvironmentScript(): Promise<string | null> {
  if (getPlatform() === 'windows') {
    logForDebugging('Session environment not yet supported on Windows')
    return null
  }

  if (sessionEnvScript !== undefined) {
    return sessionEnvScript
  }

  const scripts: string[] = []

  // Check for CLAUDE_ENV_FILE passed from parent process (e.g., HFI trajectory runner)
  // This allows venv/conda activation to persist across shell commands
  const envFile = process.env.CLAUDE_ENV_FILE
  if (envFile) {
    try {
      const envScript = (await readFile(envFile, 'utf8')).trim()
      if (envScript) {
        scripts.push(envScript)
        logForDebugging(
          `Session environment loaded from CLAUDE_ENV_FILE: ${envFile} (${envScript.length} chars)`,
        )
      }
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT') {
        logForDebugging(`Failed to read CLAUDE_ENV_FILE: ${errorMessage(e)}`)
      }
    }
  }

  // Load hook environment files from session directory
  const sessionEnvDir = await getSessionEnvDirPath()
  try {
    const files = await readdir(sessionEnvDir)
    // We are sorting the hook env files by the order in which they are listed
    // in the settings.json file so that the resulting env is deterministic
    const hookFiles = files
      .filter(f => HOOK_ENV_REGEX.test(f))
      .sort(sortHookEnvFiles)

    for (const file of hookFiles) {
      const filePath = join(sessionEnvDir, file)
      try {
        const content = (await readFile(filePath, 'utf8')).trim()
        if (content) {
          scripts.push(content)
        }
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code !== 'ENOENT') {
          logForDebugging(
            `Failed to read hook file ${filePath}: ${errorMessage(e)}`,
          )
        }
      }
    }

    if (hookFiles.length > 0) {
      logForDebugging(
        `Session environment loaded from ${hookFiles.length} hook file(s)`,
      )
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(
        `Failed to load session environment from hooks: ${errorMessage(e)}`,
      )
    }
  }

  if (scripts.length === 0) {
    logForDebugging('No session environment scripts found')
    sessionEnvScript = null
    return sessionEnvScript
  }

  sessionEnvScript = scripts.join('\n')
  logForDebugging(
    `Session environment script ready (${sessionEnvScript.length} chars total)`,
  )
  return sessionEnvScript
}

const HOOK_ENV_PRIORITY: Record<string, number> = {
  setup: 0,
  sessionstart: 1,
  cwdchanged: 2,
  filechanged: 3,
}
const HOOK_ENV_REGEX =
  /^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/

function sortHookEnvFiles(a: string, b: string): number {
  const aMatch = a.match(HOOK_ENV_REGEX)
  const bMatch = b.match(HOOK_ENV_REGEX)
  const aType = aMatch?.[1] || ''
  const bType = bMatch?.[1] || ''
  if (aType !== bType) {
    return (HOOK_ENV_PRIORITY[aType] ?? 99) - (HOOK_ENV_PRIORITY[bType] ?? 99)
  }
  const aIndex = parseInt(aMatch?.[2] || '0', 10)
  const bIndex = parseInt(bMatch?.[2] || '0', 10)
  return aIndex - bIndex
}

// ---------------------------------------------------------------------------
// CC 2.1.296 #036: plain-assignment parser for the session environment.
// Ported from the official 2.1.296 binary (`K8n` line regex, `V8n` quote
// unwrap regex, `A_t` map builder — forensics-batch7 "cOe continuation").
// PowerShell cannot dot-source the bash-style session env script, so the
// official builds a Map of the plain assignments and injects them into the
// pwsh child-process env. ALL-OR-NOTHING: every line of the joined script
// must be a comment/blank or a plain assignment (optionally `export ` /
// `declare -x ` prefixed); any other line (functions, conditionals, command
// substitutions, ...) yields an EMPTY map — no partial application.
// ---------------------------------------------------------------------------

/** Official `K8n` — VERBATIM from the 2.1.296 binary. */
export const PLAIN_ASSIGNMENT_LINE_REGEX =
  /^(?:\s*(?:#.*)?|(?:export +|declare -x +)?([A-Za-z_]\w*)=((?:[\w@%+=:,./-]|'[^'\0]*'|"(?:[^"\\$`\0]|\\[^\0])*")*))$/

/** Official `V8n` — VERBATIM from the 2.1.296 binary. */
const QUOTE_UNWRAP_REGEX = /'([^']*)'|"((?:[^"\\]|\\.)*)"/g

/** Official `V8n` replacement's inner unescape — `\\([$`"\\])` → `$1`. */
const DOUBLE_QUOTE_UNESCAPE_REGEX = /\\([$`"\\])/g

/**
 * Official `A_t`: parse the session environment script (same joined script
 * the bash path dot-sources) into a key→value Map of plain assignments.
 * Returns an EMPTY Map when any line is not a comment/blank/plain assignment
 * ("Session environment is not all plain assignments").
 *
 * DEVIATION NOTE: the official has a Windows-only branch (a value containing
 * `/` or `\` DELETES the key — path-mangling protection). OCC's
 * getSessionEnvironmentScript() returns null on Windows already, so that
 * branch is dead here and omitted; the parser itself is platform-agnostic.
 */
export async function getSessionEnvironmentMap(): Promise<
  Map<string, string>
> {
  const script = await getSessionEnvironmentScript()
  const result = new Map<string, string>()
  for (const line of script?.split('\n') ?? []) {
    const match = PLAIN_ASSIGNMENT_LINE_REGEX.exec(line.trimEnd())
    if (match === null) {
      logForDebugging('Session environment is not all plain assignments')
      return new Map()
    }
    const [, key, value] = match
    // Comment/blank lines match with undefined groups — skip them.
    if (key === undefined || value === undefined) {
      continue
    }
    const unwrapped = value.replace(
      QUOTE_UNWRAP_REGEX,
      (_full, singleQuoted: string | undefined, doubleQuoted: string | undefined) =>
        singleQuoted ??
        doubleQuoted?.replace(DOUBLE_QUOTE_UNESCAPE_REGEX, '$1') ??
        '',
    )
    result.set(key, unwrapped)
  }
  return result
}
