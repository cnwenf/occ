/**
 * GitLab MR status via the `glab` CLI (CC 2.1.234 binary alignment).
 *
 * The official 2.1.234 release adds a footer badge for open GitLab merge
 * requests: when the `gh` PR path finds nothing, it falls back to polling
 * `glab mr view -F json` in the current repo (binary poller `cpp`, top-level
 * composition `bpp` = `await ghPrStatus() ?? await glabMrStatus()` with the
 * `tengu_harbor_prism` flag off). This module is a faithful port of that
 * poller — all regexes, timeouts, env scrubbing, and error-classification
 * branches are byte-verified against the 2.1.234 linux-x64 binary.
 *
 * Security notes (all from the binary):
 * - GITLAB_TOKEN / GITLAB_ACCESS_TOKEN / OAUTH_TOKEN are scrubbed from the
 *   glab child env — glab must authenticate via its own stored login, and an
 *   "unauthenticated" failure is remembered per-host so we stop re-polling.
 * - The `web_url` returned by glab is validated against a strict
 *   https MR-URL pattern (and its trailing number must equal the iid) before
 *   it is ever rendered as a link.
 */

import { z } from 'zod/v4'
import { logEvent } from '../services/analytics/index.js'
import { logForDebugging } from './debug.js'
import { detectCurrentRepositoryWithHost } from './detectRepository.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getIsGit } from './git.js'
import type { PrReviewState } from './ghPrStatus.js'
import { which } from './which.js'

export type MrStatus = {
  number: number
  url: string
  reviewState: PrReviewState
  kind: 'mr'
}

/** glab poll timeout — binary `s3b`, byte-verified. */
const GLAB_TIMEOUT_MS = 2500

/**
 * glab's "not logged in" message shape — binary `ipp`, byte-verified.
 * Matched against stdout AND stderr of a failed `glab mr view`.
 */
const GLAB_UNAUTHENTICATED_PATTERN =
  /^\s*\S+ has not been authenticated with glab\s*$/m

/**
 * MR web_url validation — binary `opp`, built from the binary's `Ker` (path
 * segment), `hya` (hostname), and `gya` (`/-/merge_requests` path) fragments,
 * byte-verified. Accepts only `https?://<host>[:port]/<group>/<project>/-/merge_requests/<id>`.
 */
const PATH_SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9_.][\w.-]*`
const HOSTNAME = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*`
const MR_PATH = `(?:${PATH_SEGMENT}/)+${PATH_SEGMENT}/-/merge_requests`
const MR_URL_PATTERN = new RegExp(
  `^https?://${HOSTNAME}(?::\\d{1,5})?/${MR_PATH}/\\d+$`,
)

/**
 * `glab mr view -F json` response shape — binary `c3b` zod schema,
 * byte-verified.
 */
const GitLabMrSchema = z.object({
  iid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: z.string(),
  draft: z.boolean().optional(),
  detailed_merge_status: z.string().optional(),
  web_url: z.string(),
})

/** JSON.parse that returns undefined instead of throwing — binary `spp`. */
function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * glab CLI error-object shape (`{"error": {...}}`) — binary `app`,
 * byte-verified. Used to distinguish a glab-level error response (which is
 * quietly ignored) from an unresponsive/malformed one (telemetry + retry).
 */
function isGlabErrorObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error: unknown }).error === 'object' &&
    (value as { error: unknown }).error !== null
  )
}

/**
 * Validate a glab-reported web_url before it is rendered as a link — binary
 * `u3b`, byte-verified: length cap, strict MR-URL pattern, and the trailing
 * URL number must equal the MR iid.
 */
export function validateMrUrl(url: string, iid: number): boolean {
  if (url.length > 2048 || !MR_URL_PATTERN.test(url)) return false
  return Number(url.slice(url.lastIndexOf('/') + 1)) === iid
}

/**
 * Map glab MR state to the badge review state — binary `d3b`, byte-verified.
 * Only `opened` MRs get a badge; drafts show as 'draft'; `mergeable`
 * detailed_merge_status shows as 'approved', anything else 'pending'.
 */
export function deriveMrReviewState(
  state: string,
  isDraft: boolean,
  detailedMergeStatus: string | undefined,
): PrReviewState | null {
  if (state !== 'opened') return null
  if (isDraft) return 'draft'
  return detailedMergeStatus === 'mergeable' ? 'approved' : 'pending'
}

/** Strip trailing dots from a hostname — binary `Fdu`, byte-verified. */
function stripTrailingDots(host: string): string {
  let result = host
  while (result.endsWith('.')) result = result.slice(0, -1)
  return result
}

/**
 * Normalize a host for comparison — binary `L9e`, byte-verified: drop
 * whitespace-class characters, lowercase, and re-derive the hostname through
 * URL parsing when the input looks like a bare host.
 */
export function normalizeHost(host: string): string {
  const cleaned = stripTrailingDots(
    host.replace(/[\t\n\r]/g, '').toLowerCase(),
  )
  if (cleaned === '' || /[:/\\?#@\s]/.test(cleaned)) return cleaned
  try {
    const parsed = new URL(`https://${cleaned}`)
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return cleaned
    }
    return stripTrailingDots(parsed.hostname)
  } catch {
    return cleaned
  }
}

/** Host equality after normalization + www-strip — binary `DLs`. */
function isSameHost(host: string, target: string): boolean {
  let normalized = normalizeHost(host)
  while (normalized.startsWith('www.')) normalized = normalized.slice(4)
  return normalized === target
}

/** github.com check — binary `om`. */
export function isGitHubHost(host: string): boolean {
  return isSameHost(host, 'github.com')
}

/**
 * Classify the git-remote host — binary `ACt`, byte-verified. GitHub remotes
 * are skipped (the `gh` path owns them); everything else is eligible for the
 * glab poll (gitlab.com, self-hosted GitLab, and other hosts where glab may
 * be configured).
 */
export function classifyHost(
  host: string,
): 'github' | 'gitlab' | 'bitbucket' | 'other' {
  if (isGitHubHost(host)) return 'github'
  let normalized = normalizeHost(host)
  while (normalized.startsWith('www.')) normalized = normalized.slice(4)
  if (normalized === 'gitlab.com') return 'gitlab'
  if (normalized === 'bitbucket.org') return 'bitbucket'
  return 'other'
}

// Module-level poller state — binary `lpp` instance semantics.
let glabOnPathCache: boolean | null = null
const unauthenticatedHosts = new Set<string>()
let okEmitted = false

/** Reset cached poller state (tests). */
export function clearGlabStatusCachesForTesting(): void {
  glabOnPathCache = null
  unauthenticatedHosts.clear()
  okEmitted = false
}

/** glab-on-PATH check, cached after first run — binary `isGlabOnPath`. */
async function isGlabOnPath(): Promise<boolean> {
  if (glabOnPathCache === null) {
    glabOnPathCache = (await which('glab')) !== null
  }
  return glabOnPathCache
}

/** Telemetry + warn log for a failed poll — binary `VZo` (returns the
 * 'fetch-failed' sentinel upstream; OCC collapses it to null at the
 * fetchPrStatus boundary since it has no poller-bad-streak consumer). */
function reportFailure(reason: string): 'fetch-failed' {
  logEvent('gitlab_mr_badge', { reason })
  logForDebugging(`gitlab_mr_badge: ${reason}`)
  return 'fetch-failed'
}

/** Fire the success telemetry event once per process — binary `emitOkOnce`. */
function emitOkOnce(): void {
  if (okEmitted) return
  okEmitted = true
  logEvent('gitlab_mr_badge', { reason: 'ok' })
}

/**
 * Fetch open-MR status for the current repo via `glab mr view -F json` —
 * binary `cpp` port, byte-verified gate order:
 * not-in-git / glab-not-on-PATH / no-remote-host / github-host /
 * known-unauthenticated-host → null, then the 2.5s glab call with token env
 * scrubbed, error classification, schema validation, web_url validation, and
 * state mapping.
 *
 * Returns null when no badge should show, 'fetch-failed' when the poll failed
 * transiently (upstream OCC renders nothing either), or the MR status.
 */
export async function fetchMrStatus(): Promise<
  MrStatus | 'fetch-failed' | null
> {
  const isGit = await getIsGit()
  if (!isGit) return null

  if (!(await isGlabOnPath())) return null

  const repository = await detectCurrentRepositoryWithHost()
  const host = repository?.host ?? null
  if (host === null) return null

  if (classifyHost(host) === 'github') return null

  if (unauthenticatedHosts.has(host)) return null

  const { stdout, stderr, code } = await execFileNoThrow(
    'glab',
    ['mr', 'view', '-F', 'json'],
    {
      timeout: GLAB_TIMEOUT_MS,
      preserveOutputOnError: true,
      useCwd: true,
      env: {
        ...process.env,
        GITLAB_TOKEN: undefined,
        GITLAB_ACCESS_TOKEN: undefined,
        OAUTH_TOKEN: undefined,
      },
    },
  )

  if (code !== 0) {
    if (
      GLAB_UNAUTHENTICATED_PATTERN.test(stdout) ||
      GLAB_UNAUTHENTICATED_PATTERN.test(stderr)
    ) {
      unauthenticatedHosts.add(host)
      return null
    }
    const errorBody = parseJsonSafe(stdout)
    if (errorBody === undefined) return reportFailure('glab_unresponsive')
    if (isGlabErrorObject(errorBody)) return null
    return reportFailure('glab_unresponsive')
  }

  const body = parseJsonSafe(stdout)
  if (body === undefined) return reportFailure('parse_failed')
  if (isGlabErrorObject(body)) return null

  const parsed = GitLabMrSchema.safeParse(body)
  if (!parsed.success) return reportFailure('parse_failed')
  const mr = parsed.data

  if (!validateMrUrl(mr.web_url, mr.iid)) {
    logEvent('gitlab_mr_badge', { reason: 'web_url_rejected' })
    logForDebugging('gitlab_mr_badge: web_url_rejected')
    return null
  }

  const reviewState = deriveMrReviewState(
    mr.state,
    mr.draft === true,
    mr.detailed_merge_status,
  )
  if (reviewState === null) return null

  emitOkOnce()
  return {
    number: mr.iid,
    url: mr.web_url,
    reviewState,
    kind: 'mr',
  }
}
