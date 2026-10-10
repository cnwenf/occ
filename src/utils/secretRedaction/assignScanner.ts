// biome-ignore-all lint/complexity/noCommaOperator: comma operators are byte-exact from the official 2.1.296 minified source (verbatim port)
// biome-ignore-all lint/correctness/noEmptyCharacterClassInRegex: [^] is the intentional JS any-char class in the official quoted-string detector (verbatim port)
/**
 * Two-phase plain/escaped key=value assign scanner (new in official 2.1.296).
 *
 * Ported verbatim from the official Claude Code 2.1.296 linux-x64 binary
 * (evidence window /tmp/cc296/ev-rules296.txt; upstream symbols ls/on/bn/Ye,
 * constants as/us/fn/pn and the phase regexes built from qe/et/gn/ts/ns).
 *
 * This is the mechanism behind the 2.1.296 changelog fix: "Fixed secret
 * redaction in shared transcripts and debug logs missing some values that
 * follow a key with no value, including in JSON written inside a shell
 * string." A key with NO value (e.g. `token=`) opens a lookahead window
 * (nextKey, capped at MAX_ASSIGN_GAP=512 chars) whose VALUE span is
 * redacted instead - and the escaped phase additionally handles `\"key\":`
 * JSON embedded in a shell string.
 *
 * Upstream symbol map (readable OCC name <- minified 296 name):
 *   scanAssignSpans <- ls, scanPhase <- on, mergeSpans <- bn,
 *   PHASES <- Ye, VALUE_TAIL_RE <- as (new RegExp(pn,"y")),
 *   MAX_ASSIGN_GAP <- us (512), ESCAPED_QUOTE_RE <- fn.
 * The assign/nextKey/valueWithWhitespace regex sources come from rules.ts
 * exports (PLAIN_NEXT_KEY_SOURCE / ESCAPED_NEXT_KEY_SOURCE / MASKED_TAIL);
 * the escaped assign phase also unions the sensitive-assign-escaped source
 * (upstream gn), and the plain phase the sensitive-assign + cloud-env-var
 * sources (upstream qe/et).
 *
 * Documented divergence: the phase regex literals are constructed from the
 * exported source constants rather than re-inlined - the resulting RegExp
 * sources are byte-identical to upstream.
 */

import {
  SENSITIVE_ASSIGN_SOURCE,
  CLOUD_ENV_VAR_SOURCE,
  SENSITIVE_ASSIGN_ESCAPED_SOURCE,
  PLAIN_NEXT_KEY_SOURCE,
  ESCAPED_NEXT_KEY_SOURCE,
  MASKED_TAIL,
  AUTH_SCHEME_SOURCE,
} from './rules.js'

// upstream fn: /\\["']/ - does the text contain escaped quotes at all?
var ESCAPED_QUOTE_RE = /\\["']/
// upstream as: new RegExp(pn,"y") - sticky masked-value tail prober
var VALUE_TAIL_RE = new RegExp(MASKED_TAIL, 'y')
// upstream us: maximum key-to-next-key gap for the no-value lookahead
var MAX_ASSIGN_GAP = 512

// upstream Ye: the two scanner phases (lazily-built singletons)
var PHASES = {
  plain: {
    assign: new RegExp(`${SENSITIVE_ASSIGN_SOURCE}|${CLOUD_ENV_VAR_SOURCE}`, 'gi'),
    nextKey: new RegExp(PLAIN_NEXT_KEY_SOURCE, 'iy'),
    valueWithWhitespace: new RegExp(`["']|${AUTH_SCHEME_SOURCE}`, 'iy'),
    skipsStrays: !1,
  },
  escaped: {
    assign: new RegExp(
      `${SENSITIVE_ASSIGN_SOURCE}|${CLOUD_ENV_VAR_SOURCE}|${SENSITIVE_ASSIGN_ESCAPED_SOURCE}`,
      'gi',
    ),
    nextKey: new RegExp(ESCAPED_NEXT_KEY_SOURCE, 'iy'),
    valueWithWhitespace: new RegExp(`\\\\*["']|${AUTH_SCHEME_SOURCE}`, 'iy'),
    skipsStrays: !0,
  },
}

// upstream on: walk one phase, emitting [start,end) value spans.
// A match whose NEXT key was found within MAX_ASSIGN_GAP and whose own
// value slot is empty/short arms `a` (the next-key index); the following
// match at index < a then pushes ITS value span (the key-with-no-value
// chain case). Quote-wrapped values keep the inner span ([m+1,p-1]).
function scanPhase(e, n) {
  let { assign: r, nextKey: s, valueWithWhitespace: l, skipsStrays: i } = n,
    o = [],
    a,
    u = 0
  r.lastIndex = 0
  for (let c = r.exec(e); c !== null; c = r.exec(e)) {
    let d = c[1] ?? c[2] ?? c[3],
      p = c.index + c[0].length,
      m = p - d.length
    s.lastIndex = m
    let h = d.length <= MAX_ASSIGN_GAP && s.test(e) ? s.lastIndex : void 0
    if (h !== void 0 && h < p) {
      if ((l.lastIndex = h), !l.test(e)) h = void 0
    }
    if (i && a !== void 0 && c.index >= a && c.index < u && h === void 0) {
      ;(a = void 0), (r.lastIndex = u)
      continue
    }
    if (a !== void 0 && c.index < a) {
      let k = /^(["'])[^]*\1$/.test(d),
        f = k && u <= m ? 1 : 0
      ;(l.lastIndex = p), o.push([m + f, !k && l.test(e) ? l.lastIndex : p - f])
    }
    if (((u = p), (a = h), a !== void 0)) r.lastIndex = m
  }
  return o
}

// upstream bn: filter empty, sort by start, merge overlapping spans.
function mergeSpans(e) {
  let n = e.filter(([s, i]) => i > s).sort((s, i) => s[0] - i[0]),
    r = []
  for (let [s, i] of n) {
    let o = r.at(-1)
    if (o !== void 0 && s <= o[1]) o[1] = Math.max(o[1], i)
    else r.push([s, i])
  }
  return r
}

// upstream ls: plain phase always; escaped phase only when \["'] appears.
function scanAssignSpans(e) {
  let n = scanPhase(e, PHASES.plain)
  return ESCAPED_QUOTE_RE.test(e) ? [...n, ...scanPhase(e, PHASES.escaped)] : n
}

export { scanAssignSpans, scanPhase, mergeSpans, MAX_ASSIGN_GAP }
