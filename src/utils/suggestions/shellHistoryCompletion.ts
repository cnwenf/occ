import { getHistory } from '../../history.js'
import { logForDebugging } from '../debug.js'

/**
 * Result of shell history completion lookup
 */
export type ShellHistoryMatch = {
  /** The full command from history */
  fullCommand: string
  /** The suffix to display as ghost text (the part after user's input) */
  suffix: string
}

// Cache for shell history commands to avoid repeated async reads
// History only changes when user submits a command, so a long TTL is fine
let shellHistoryCache: string[] | null = null
let shellHistoryCacheTimestamp = 0
const CACHE_TTL_MS = 60000 // 60 seconds - history won't change while typing

/**
 * Get shell commands from history, with caching
 */
async function getShellHistoryCommands(): Promise<string[]> {
  const now = Date.now()

  // Return cached result if still fresh
  if (shellHistoryCache && now - shellHistoryCacheTimestamp < CACHE_TTL_MS) {
    return shellHistoryCache
  }

  const commands: string[] = []
  const seen = new Set<string>()

  try {
    // Read history entries and filter for bash commands
    for await (const entry of getHistory()) {
      if (entry.display && entry.display.startsWith('!')) {
        // Remove the '!' prefix to get the actual command
        const command = entry.display.slice(1).trim()
        if (command && !seen.has(command)) {
          seen.add(command)
          commands.push(command)
        }
      }
      // Limit to 50 most recent unique commands
      if (commands.length >= 50) {
        break
      }
    }
  } catch (error) {
    logForDebugging(`Failed to read shell history: ${error}`)
  }

  shellHistoryCache = commands
  shellHistoryCacheTimestamp = now
  return commands
}

/**
 * Clear the shell history cache (useful when history is updated)
 */
export function clearShellHistoryCache(): void {
  shellHistoryCache = null
  shellHistoryCacheTimestamp = 0
}

/**
 * Add a command to the front of the shell history cache without
 * flushing the entire cache.  If the command already exists in the
 * cache it is moved to the front (deduped).  When the cache hasn't
 * been populated yet this is a no-op – the next lookup will read
 * the full history which already includes the new command.
 */
export function prependToShellHistoryCache(command: string): void {
  if (!shellHistoryCache) {
    return
  }
  const idx = shellHistoryCache.indexOf(command)
  if (idx !== -1) {
    shellHistoryCache.splice(idx, 1)
  }
  shellHistoryCache.unshift(command)
}

/**
 * Find the best matching shell command from history for the given input
 *
 * @param input The current user input (without '!' prefix)
 * @returns The best match, or null if no match found
 */
export async function getShellHistoryCompletion(
  input: string,
): Promise<ShellHistoryMatch | null> {
  // Don't suggest for empty or very short input
  if (!input || input.length < 2) {
    return null
  }

  // Check the trimmed input to make sure there's actual content
  const trimmedInput = input.trim()
  if (!trimmedInput) {
    return null
  }

  const commands = await getShellHistoryCommands()

  // Find the first command that starts with the EXACT input (including spaces)
  // This ensures "ls " matches "ls -lah" but "ls  " (2 spaces) does not
  for (const command of commands) {
    if (command.startsWith(input) && command !== input) {
      return {
        fullCommand: command,
        suffix: command.slice(input.length),
      }
    }
  }

  return null
}

/**
 * Whether the in-memory shell-history cache has been populated at least once.
 * Used by the render-path sync lookup to decide whether to fall back to the
 * async warm-up.
 */
export function isShellHistoryCacheWarm(): boolean {
  return shellHistoryCache != null
}

/**
 * Synchronous shell-history completion from the in-memory cache.
 *
 * Returns null if the cache hasn't been populated yet (cold start) or no match
 * exists. Use this in render paths (useMemo) to compute bash ghost text in the
 * SAME render as the keystroke — the async getShellHistoryCompletion resolves
 * in a microtask, so using it for ghost text caused a second render per
 * keystroke and the terminal flickered/jumped while typing in bash mode
 * (2.1.203). The async warm-up populates the cache on entering bash mode;
 * once warm, this sync lookup is authoritative for the typing session (shell
 * history only changes on command submit, which clears the cache).
 */
export function getShellHistoryCompletionSync(
  input: string,
): ShellHistoryMatch | null {
  if (!input || input.length < 2) {
    return null
  }
  if (!input.trim()) {
    return null
  }
  // Cache not populated yet — caller should fire the async warm-up.
  if (!shellHistoryCache) {
    return null
  }
  for (const command of shellHistoryCache) {
    if (command.startsWith(input) && command !== input) {
      return {
        fullCommand: command,
        suffix: command.slice(input.length),
      }
    }
  }
  return null
}

/**
 * Warm the shell-history cache by reading the history file once. Safe to call
 * repeatedly — a no-op while a read is already in flight and returns fast once
 * the cache is populated (TTL-bounded). Resolves when the cache is usable by
 * getShellHistoryCompletionSync.
 */
export async function warmShellHistoryCache(): Promise<void> {
  await getShellHistoryCommands()
}
