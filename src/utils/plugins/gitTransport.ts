/**
 * Git URL transport detection for plugin / marketplace clones — faithful port
 * of the official Claude Code v287 transport parser `Se` (@201495046) and the
 * partial-clone predicate `F4n` (@201495013), whose allowlist is the official
 * `he=["https","ssh"]` (@201494988).
 *
 * Why (official v287 fix): the official binary pins `GIT_ALLOW_PROTOCOL`
 * (base pins `zo`/`ze`, https:ssh seed) around its vetted git operations. A
 * partial clone (`--filter=…`) over a plain-http remote therefore dies at the
 * follow-up sparse-checkout / checkout step, which lazy-fetches blobs and trees
 * from the promisor remote over the blocked http transport
 * (`fatal: transport 'http' not allowed`). v287 only partial-clones when the URL
 * transport is https or ssh; over http it does a full (still `--depth 1`) clone
 * with no lazy fetches.
 *
 * The parser recognizes git's `transport::command` remote-helper form,
 * normalizes `git+ssh://` / `ssh+git://` to `ssh`, treats scp-like
 * `user@host:path` as `ssh`, and local paths (plus Windows drive letters) as
 * `file`.
 *
 * Byte-fidelity notes:
 * - All three regexes below are verbatim from the recovered official source.
 * - The scheme is returned EXACTLY as matched — the official parser does not
 *   lowercase it (the `://` form's regex is `/i` but the capture is raw), so
 *   `HTTPS://x` yields `HTTPS`, which is NOT in the partial-clone allowlist.
 *   Ported as-is; no normalization was added.
 * - Official `O()==="windows"` is replaced by OCC's platform check
 *   `getPlatform() === 'windows'` — the same mapping the sibling plugin util
 *   `gitSshCommand.ts` uses for `O()`.
 *
 * SCOPE / STAGED. Only the transport parser + predicate are ported here. The
 * v287 diagnostics half — the `gt=/^fatal: transport '([A-Za-z][A-Za-z0-9+.-]{0,31})'
 * not allowed$/m` stderr matcher, the lazy-fetch retry handler's `transports:h`
 * annotation (retry-env builder `Tt` @201499864) — belongs to the partial-clone
 * retry subsystem, which is part of the STAGED git-env hardening effort and has
 * no OCC counterpart (`rg "GIT_NO_LAZY_FETCH" src` → comment-only). Not ported.
 */

import { getPlatform } from '../platform.js'

/**
 * Official `he` (@201494988): the transports over which a partial clone's lazy
 * fetches are allowed, and therefore the only transports OCC partial-clones.
 */
const PARTIAL_CLONE_TRANSPORTS = ['https', 'ssh']

/** Official `O()` ≡ OCC `getPlatform()` (see gitSshCommand.ts `isWindows`). */
function isWindows(): boolean {
  return getPlatform() === 'windows'
}

/**
 * Official `Se` (@201495046), verbatim:
 *
 * ```js
 * function Se(e){let n=/^[A-Za-z0-9][A-Za-z0-9+.-]*(?=::)/.exec(e)?.[0];if(n!==void 0)return n;
 * let r=/^([a-z][a-z0-9+.-]*):\/\//i.exec(e)?.[1];if(r!==void 0)return r==="git+ssh"||r==="ssh+git"?"ssh":r;
 * let s=e.indexOf(":"),o=e.indexOf("/");
 * return s===-1||o!==-1&&o<s||O()==="windows"&&/^[A-Za-z]:[\\/]/.test(e)?"file":"ssh"}
 * ```
 *
 * Returns the transport name for a git URL: a remote-helper prefix
 * (`ext::cmd` → `ext`), a `scheme://` scheme (`git+ssh`/`ssh+git` → `ssh`),
 * `file` for a path-like address (no colon, a slash before the colon, or a
 * Windows drive letter), and `ssh` otherwise (scp-like `user@host:path`).
 */
export function gitUrlTransport(url: string): string {
  const helper = /^[A-Za-z0-9][A-Za-z0-9+.-]*(?=::)/.exec(url)?.[0]
  if (helper !== undefined) return helper
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]
  if (scheme !== undefined) {
    return scheme === 'git+ssh' || scheme === 'ssh+git' ? 'ssh' : scheme
  }
  const colon = url.indexOf(':')
  const slash = url.indexOf('/')
  return colon === -1 ||
    (slash !== -1 && slash < colon) ||
    (isWindows() && /^[A-Za-z]:[\\/]/.test(url))
    ? 'file'
    : 'ssh'
}

/**
 * Official `F4n` (@201495013): `function F4n(e){return he.includes(Se(e))}` —
 * true when the URL's transport allows partial-clone lazy fetches (https/ssh).
 * When false, callers clone fully (no `--filter=`) so nothing has to be
 * lazy-fetched later over a transport git may block.
 */
export function isPartialCloneTransport(url: string): boolean {
  return PARTIAL_CLONE_TRANSPORTS.includes(gitUrlTransport(url))
}
