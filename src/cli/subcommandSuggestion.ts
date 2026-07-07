/**
 * E32 (2.1.111): closest-matching subcommand ("Did you mean") suggestion.
 *
 * The top-level `claude` command takes a `[prompt]` positional, so a typo'd
 * subcommand (e.g. `claude agnets`) is silently routed to the main action as
 * a prompt instead of erroring. When that single token closely matches a
 * registered subcommand name or alias, the caller prints
 * `Unknown command: <word>. Did you mean '<suggestion>'?` and exits —
 * mirroring the 2.1.200 binary's `Unknown command: ` handler.
 *
 * Uses Levenshtein edit distance ≤2, matching the slash-command suggestion
 * in processSlashCommand.tsx (the binary reuses the same ≤2 threshold).
 */

type SubcommandLike = {
  commands: ReadonlyArray<{ name(): string; aliases(): string[] }>
}

/** Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const curr = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[n]
}

/** Names + aliases of all top-level subcommands registered on `program`. */
function getSubcommandNames(program: SubcommandLike): string[] {
  const names: string[] = []
  for (const cmd of program.commands) {
    const name = cmd.name()
    if (name) names.push(name)
    for (const alias of cmd.aliases()) names.push(alias)
  }
  return names
}

/**
 * Return the closest registered subcommand name/alias within edit distance ≤2
 * of `word`, or undefined when no close match exists. `word` itself is never
 * returned (an exact match is a real subcommand and never reaches the main
 * action).
 */
export function findClosestSubcommand(
  word: string,
  program: SubcommandLike,
): string | undefined {
  if (!word) return undefined
  let best: string | undefined
  let bestDist = Infinity
  for (const name of getSubcommandNames(program)) {
    if (name === word) continue
    const dist = levenshtein(word, name)
    if (dist > 0 && dist <= 2 && dist < bestDist) {
      best = name
      bestDist = dist
    }
  }
  return best
}
