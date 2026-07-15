/**
 * Vim INSERT-mode key-sequence remaps (claude-code 2.1.208+).
 *
 * Reverse-engineered from the official 2.1.210 binary. Allows users to remap a
 * two-key sequence typed in vim INSERT mode to Escape (e.g. `{"jj": "<Esc>"}`).
 * When the user types the first key, then the second key within the timeout,
 * both keys are removed from the buffer and the editor returns to NORMAL mode.
 *
 * Binary identifiers (verified by grep on /tmp/occ-gap210/210.strings):
 * - Schema: `vimInsertModeRemaps:A.record(A.string(),A.unknown()).optional().catch(void 0).describe(...)`
 * - Normalizer `IS_`: builds a Map, keeps entries whose value case-insensitively
 *   equals "<esc>", NFC-normalizes the key, requires `/^[^\p{C}\p{Z}]{2}$/u`
 *   AND `cae(o)===2` (exactly two grapheme clusters), maps to "<Esc>".
 * - Reader `n6s`: `IS_(G5t("vimInsertModeRemaps")[0]??{})` — reads settings
 *   sources (policySettings > flagSettings > userSettings, first defined).
 * - `Edp=1000`: inter-key timeout (ms) for sequence detection.
 * - `c6s`: set of non-typeable key names excluded from remap detection.
 * - `CAt`/`Lee`: first/last grapheme cluster (Intl.Segmenter).
 * - `b`: pending-state setter — only tracks keys that are a prefix of some
 *   remap key.
 */
import { firstGrapheme, getGraphemeSegmenter, lastGrapheme } from './intl.js'
import { getSettingsForSource } from './settings/settings.js'

/**
 * Inter-key timeout (ms) for INSERT-mode remap sequence detection.
 * Mirrors the binary's `Edp=1000`. The second key must follow the first within
 * this window for the remap to fire.
 */
export const VIM_INSERT_REMAP_TIMEOUT_MS = 1000

/**
 * Escape token the normalized remap map maps every accepted key to.
 * Input values are accepted case-insensitively ("<esc>", "<ESC>", "<Esc>")
 * but always normalized to this canonical form.
 */
export const VIM_INSERT_REMAP_ESCAPE_TOKEN = '<Esc>'

/**
 * Non-typeable key names excluded from remap detection. Mirrors the binary's
 * `c6s` set. A keypress whose `key.name` is in this set can never start or
 * complete a remap sequence.
 */
export const VIM_SPECIAL_KEY_NAMES: ReadonlySet<string> = new Set([
  'backspace',
  'delete',
  'tab',
  'home',
  'end',
  'pageup',
  'pagedown',
  'insert',
  'clear',
  'enter',
  'center',
  'undefined',
  'mouse',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
])

/**
 * Count grapheme clusters in a string. Mirrors the binary's `cae(e)`:
 * `if(!e)return 0;let t=0;for(let r of ET().segment(e))t++;return t`.
 */
export function graphemeCount(text: string): number {
  if (!text) return 0
  let count = 0
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _segment of getGraphemeSegmenter().segment(text)) {
    count++
  }
  return count
}

/**
 * Normalize a raw `vimInsertModeRemaps` value into a Map<string, string>.
 * Mirrors the binary's `IS_(e)`:
 * - Skips entries whose value is not a string, or whose value (lowercased) is
 *   not exactly "<esc>" (the only supported target).
 * - NFC-normalizes the key.
 * - Keeps only keys that are exactly two printable, non-control, non-space
 *   code points (`/^[^\p{C}\p{Z}]{2}$/u`) AND exactly two grapheme clusters
 *   (`cae(o)===2`).
 * - Maps every accepted key to "<Esc>".
 *
 * Returns an empty Map for non-object / malformed input.
 */
export function normalizeVimInsertModeRemaps(
  raw: unknown,
): Map<string, string> {
  const result = new Map<string, string>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return result
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.toLowerCase() !== '<esc>') {
      continue
    }
    const normalizedKey = key.normalize('NFC')
    if (!/^[^\p{C}\p{Z}]{2}$/u.test(normalizedKey)) {
      continue
    }
    if (graphemeCount(normalizedKey) !== 2) {
      continue
    }
    result.set(normalizedKey, VIM_INSERT_REMAP_ESCAPE_TOKEN)
  }
  return result
}

/**
 * Read the configured INSERT-mode remaps from settings sources.
 * Mirrors the binary's `n6s()`:
 * `IS_(G5t("vimInsertModeRemaps")[0]??{})`.
 *
 * `G5t` reads policySettings → flagSettings → userSettings (in that priority
 * order) and returns the first source that defines the key. Returns an empty
 * Map when the setting is unset or no entries survive normalization.
 */
export function getVimInsertModeRemaps(): Map<string, string> {
  return normalizeVimInsertModeRemaps(readFirstDefinedSetting('vimInsertModeRemaps'))
}

/**
 * Read the first settings source (policy > flag > user) that defines `key`.
 * Mirrors the `[0]` indexing of `G5t`'s collected array.
 */
function readFirstDefinedSetting(key: string): unknown {
  for (const source of [
    'policySettings',
    'flagSettings',
    'userSettings',
  ] as const) {
    const settings = getSettingsForSource(source)
    if (settings) {
      const value = (settings as Record<string, unknown>)[key]
      if (value !== undefined) {
        return value
      }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// INSERT-mode remap detection (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Pending state from the previous typeable keypress. Mirrors the binary's
 * `_.current` / `G`: `{char, at, offsetAfter, recorded}`. `null` when no key is
 * pending (or the previous key could not start a remap sequence).
 */
export type PendingRemap = {
  /** Last grapheme of the previous typeable key (binary: G.char). */
  readonly char: string
  /** Timestamp of the previous keypress (binary: G.at). */
  readonly at: number
  /** Cursor offset after the previous key was inserted (binary: G.offsetAfter). */
  readonly offsetAfter: number
  /** Whether the previous key was a single codepoint (binary: G.recorded). */
  readonly recorded: boolean
} | null

/**
 * Result of evaluating a single INSERT-mode keypress against the remap config.
 */
export type RemapDetectionResult =
  | {
      readonly action: 'remap'
      readonly kind: 'twoKey'
      /** The first key of the sequence must be removed from the buffer. */
      readonly removeFirstChar: { readonly charLen: number; readonly recorded: boolean }
    }
  | { readonly action: 'remap'; readonly kind: 'singleKey' }
  | { readonly action: 'pass'; readonly nextPending: PendingRemap }

export type DetectInsertModeRemapArgs = {
  /** Normalized remap map (from getVimInsertModeRemaps). */
  readonly remaps: Map<string, string>
  /** Pending state from the previous keypress (binary: G). */
  readonly pending: PendingRemap
  /** The typed key char(s); will be NFC-normalized (binary: B.key). */
  readonly key: string
  /** ink key.name — '' for typeable, 'backspace' etc. for special (binary: B.name). */
  readonly keyName: string
  /** Current timestamp, injectable for tests (binary: Date.now()). */
  readonly now: number
  /** Cursor offset BEFORE this key is inserted (binary: W.offset). */
  readonly offset: number
  /** Buffer text BEFORE this key is inserted (binary: j.text). */
  readonly text: string
}

/**
 * Detect whether the current INSERT-mode keypress completes a configured remap
 * sequence. Mirrors the binary's INSERT-mode handler detection block.
 *
 * Two trigger paths:
 * 1. `twoKey` — the previous key's char + this key's first grapheme form a
 *    2-char sequence that is in the remap map, typed within the timeout, with
 *    no intervening cursor movement and the previous char still present in the
 *    buffer. The first key is removed and the editor returns to NORMAL.
 * 2. `singleKey` — the key itself is a 2-codepoint sequence directly in the
 *    map. The editor returns to NORMAL without inserting.
 *
 * When no remap fires, returns the next pending state (which is only set when
 * the current key's grapheme is a prefix of some remap key — binary's `b`).
 */
export function detectInsertModeRemap(
  args: DetectInsertModeRemapArgs,
): RemapDetectionResult {
  const { remaps, pending, keyName, now, offset, text } = args
  // Binary: `let te=n6s(); if(te.size>0){...}`. With no remaps configured,
  // there is nothing to detect and no pending state to track.
  if (remaps.size === 0) {
    return { action: 'pass', nextPending: null }
  }
  const se = args.key.normalize('NFC') // B.key.normalize("NFC")
  const ie = [...se].length // [...B.key].length (codepoint count)
  const ae = ie === 1 // single codepoint
  // Binary: `ee=(ae||B.name==="")&&!c6s.has(B.name)` — typeable key
  const isTypeable = (ae || keyName === '') && !VIM_SPECIAL_KEY_NAMES.has(keyName)

  // Path 1: two-key sequence (e.g. "jj").
  // Binary: `ee&&ie<=2&&G&&te.has(G.char+CAt(se))&&Date.now()-G.at<=Edp
  //   &&W.offset===G.offsetAfter&&j.text.startsWith(G.char,j.offset-G.char.length)`
  if (
    isTypeable &&
    ie <= 2 &&
    pending &&
    remaps.has(pending.char + firstGrapheme(se)) &&
    now - pending.at <= VIM_INSERT_REMAP_TIMEOUT_MS &&
    offset === pending.offsetAfter &&
    text.startsWith(pending.char, offset - pending.char.length)
  ) {
    return {
      action: 'remap',
      kind: 'twoKey',
      removeFirstChar: {
        charLen: pending.char.length,
        recorded: pending.recorded,
      },
    }
  }

  // Path 2: single 2-codepoint key directly in the map.
  // Binary: `if(ee&&!ae&&te.has(se)){...}`
  if (isTypeable && !ae && remaps.has(se)) {
    return { action: 'remap', kind: 'singleKey' }
  }

  // No trigger: update pending state. Binary: `let oe=ee?Lee(se):"";if(oe)b(...)`.
  // `b` only sets the pending state when the current grapheme is a prefix of
  // some remap key — otherwise the key cannot start a sequence.
  const grapheme = isTypeable ? lastGrapheme(se) : ''
  let nextPending: PendingRemap = null
  if (grapheme) {
    for (const remapKey of remaps.keys()) {
      if (remapKey.startsWith(grapheme)) {
        nextPending = {
          char: grapheme,
          at: now,
          // Binary: `W.offset+se.length` — offset after this key is inserted.
          offsetAfter: offset + se.length,
          // Binary: `[...B.key].length===1`.
          recorded: ie === 1,
        }
        break
      }
    }
  }
  return { action: 'pass', nextPending }
}
