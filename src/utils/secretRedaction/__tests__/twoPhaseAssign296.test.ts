/**
 * 2.1.296 two-phase assign-scanner + redactOnly/prefilter acceptance tests.
 *
 * Covers the official 2.1.296 changelog fix: "Fixed secret redaction in
 * shared transcripts and debug logs missing some values that follow a key
 * with no value, including in JSON written inside a shell string."
 *
 * All expectations were probed against the ported engine before being
 * pinned (no invented behavior); rule-source assertions are byte-exact
 * from /tmp/cc296/ev-rules296.txt.
 */

import { describe, expect, test } from 'bun:test'
import {
  redactSecrets,
  redactSecretContext,
  redactSecretsSequential,
  redactSecretTokens,
  redactSecretsWithCap,
  redactSecretForDisplay,
  redactJsonValue,
  scanSecrets,
} from '../index.js'
import { St, ESCAPED_QUOTE_RE } from '../rules.js'
import { scanAssignSpans, mergeSpans, MAX_ASSIGN_GAP } from '../assignScanner.js'

// key with no value, followed by the real key:value (286 leaked the value)
const CHAIN = 'token= api_key: "CHAINSECRETVALUE12345"'
// JSON written inside a shell string (escaped quotes)
const ESCAPED_JSON = String.raw`echo {\"secret\": \"zzzEscapedSecretValue999\"}`
const ESCAPED_KV = String.raw`echo \"api_key\": \"ESCAPEDJSONSECRET123456\"`
const OAUTH_TOKEN = 'sk-ant-oat01-abcdefghij0123456789abcd'
const LOOSE_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'

// OCC-114 coverage-gap closure — CHAIN context COMBINATION: the key-with-no-value
// chain pattern (a valueless `token=` opening a lookahead window whose value is
// the following secret) embedded INSIDE an escaped-quote (shell-string JSON)
// context. The existing suite pins CHAIN plain-only and ESCAPED_JSON
// escaped-only; these two exercise BOTH scanner phases at once (plain + escaped
// run together because ESCAPED_QUOTE_RE matches), which is the combination the
// prior acceptance round flagged as untested.
const CHAIN_IN_ESCAPED_JSON = String.raw`echo {\"token\": \"\", \"api_key\": \"CHAINCOMBOSECRETAAA111\"}`
const CHAIN_IN_ESCAPED_KV = String.raw`token= \"api_key\": \"CHAINCOMBOSECRETBBB222\"`

function ruleById(id: string) {
  const rule = St.find((r) => r.id === id)
  expect(rule).toBeDefined()
  return rule!
}

describe('two-phase assign scanner (scanAssignSpans)', () => {
  test('flags the value that follows a key with no value', () => {
    const spans = scanAssignSpans(CHAIN)
    expect(spans.length).toBeGreaterThan(0)
    const covered = spans.map(([s, i]) => CHAIN.slice(s, i)).join('|')
    expect(covered).toContain('CHAINSECRETVALUE12345')
  })

  test('redactSecrets removes the chained secret end to end', () => {
    const out = redactSecrets(CHAIN)
    expect(out).not.toContain('CHAINSECRETVALUE12345')
    expect(out).toContain('[REDACTED]')
  })

  test('mergeSpans drops empty spans and merges overlaps', () => {
    expect(
      mergeSpans([
        [0, 2],
        [1, 4],
        [5, 3],
        [7, 7],
      ]),
    ).toEqual([[0, 4]])
  })

  test('gap cap matches the official us=512 constant', () => {
    expect(MAX_ASSIGN_GAP).toBe(512)
  })
})

describe('escaped-quote JSON inside shell strings (296 changelog fix)', () => {
  test('redactSecrets redacts the escaped-JSON secret (full-redact gate ON)', () => {
    expect(redactSecrets(ESCAPED_JSON)).not.toContain('zzzEscapedSecretValue999')
  })

  test('redactSecretContext leaves it (redactOnly gate OFF by default)', () => {
    expect(redactSecretContext(ESCAPED_JSON)).toBe(ESCAPED_JSON)
  })

  test('redactSecretsSequential leaves it (context gate OFF + tokens only)', () => {
    expect(redactSecretsSequential(ESCAPED_JSON)).toBe(ESCAPED_JSON)
  })

  test('redactSecretForDisplay leaves it (low-confidence rule, display path)', () => {
    expect(redactSecretForDisplay(ESCAPED_JSON)).toBe(ESCAPED_JSON)
  })

  test('redactJsonValue redacts escaped JSON in a shell command string', () => {
    const out = redactJsonValue({ command: ESCAPED_KV })
    expect(JSON.stringify(out)).not.toContain('ESCAPEDJSONSECRET123456')
    expect(out.command).toContain('[REDACTED]')
  })
})

describe('CHAIN context combination — valueless-key chain inside an escaped-quote context', () => {
  // Both inputs contain escaped quotes, so scanAssignSpans runs the plain phase
  // AND the escaped phase (ESCAPED_QUOTE_RE gate). The security-critical property
  // is end-to-end: redactSecrets must strip the secret in BOTH shapes. The
  // valueless-key chain span (the exact 296 fix) is what covers the escaped-KV
  // shape; the escaped-JSON shape is caught by the sensitive-assign-escaped rule
  // directly. Both are pinned so the combination cannot silently regress.
  test('ESCAPED_QUOTE_RE fires so both phases run', () => {
    expect(ESCAPED_QUOTE_RE.test(CHAIN_IN_ESCAPED_JSON)).toBe(true)
    expect(ESCAPED_QUOTE_RE.test(CHAIN_IN_ESCAPED_KV)).toBe(true)
  })

  test('escaped-JSON empty-value-then-secret: redactSecrets removes the secret end to end', () => {
    const out = redactSecrets(CHAIN_IN_ESCAPED_JSON)
    expect(out).not.toContain('CHAINCOMBOSECRETAAA111')
    expect(out).toContain('[REDACTED]')
  })

  test('escaped-KV chain: the valueless-key chain span covers the secret', () => {
    const covered = mergeSpans(scanAssignSpans(CHAIN_IN_ESCAPED_KV))
      .map(([s, e]) => CHAIN_IN_ESCAPED_KV.slice(s, e))
      .join('|')
    expect(covered).toContain('CHAINCOMBOSECRETBBB222')
  })

  test('escaped-KV chain: redactSecrets removes the chained secret end to end', () => {
    const out = redactSecrets(CHAIN_IN_ESCAPED_KV)
    expect(out).not.toContain('CHAINCOMBOSECRETBBB222')
    expect(out).toContain('[REDACTED]')
  })
})

describe('prefilter behavior', () => {
  test('scan honors the run-rule prefilter (anthropic-oauth-token found)', () => {
    expect(scanSecrets(`${OAUTH_TOKEN} end`)).toEqual([
      { ruleId: 'anthropic-oauth-token', label: 'Anthropic OAuth Token' },
    ])
  })

  test('redactSecretTokens redacts the run-wrapped oauth token', () => {
    const out = redactSecretTokens(`x ${OAUTH_TOKEN} y`)
    expect(out).not.toContain('sk-ant-oat01')
    expect(out).toContain('[REDACTED]')
  })

  test('loose-jwt still fires through the low-confidence context path', () => {
    const out = redactSecretContext(`see ${LOOSE_JWT} now`)
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  test('loose-jwt end to end via redactSecrets', () => {
    expect(redactSecrets(`see ${LOOSE_JWT} now`)).toBe('see [REDACTED] now')
  })

  test('displayRun branch redacts gitlab tokens on the display path', () => {
    expect(redactSecretForDisplay('token glpat-abcdefghij0123456789ABCDEF end')).toBe(
      'token [REDACTED] end',
    )
  })
})

describe('2.1.296 rule-table spot checks', () => {
  test('table has exactly 64 rules', () => {
    expect(St.length).toBe(64)
  })

  test('low-confidence rule order matches the official table', () => {
    expect(St.map((r) => r.id).slice(0, 12)).toEqual([
      'url-userinfo',
      'gcp-service-account',
      'loose-anthropic-key',
      'http-auth-scheme',
      'loose-jwt',
      'sensitive-assign',
      'cloud-env-var',
      'url-userinfo-tail',
      'url-userinfo-later-at',
      'url-userinfo-encoded',
      'masked-value-rest',
      'sensitive-assign-escaped',
    ])
  })

  test('sensitive-assign-escaped is redactOnly with the escaped-quote prefilter', () => {
    const rule = ruleById('sensitive-assign-escaped')
    expect(rule.redactOnly).toBe(true)
    expect(rule.prefilter).toBe(ESCAPED_QUOTE_RE)
    expect(rule.confidence).toBe('low')
    expect(rule.flags).toBe('i')
  })

  test('loose-jwt source is byte-exact (lookbehind/lookahead boundaries)', () => {
    expect(ruleById('loose-jwt').source).toBe(
      '(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*)(?:[A-Za-z0-9_-]*?-)??(eyJ[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*)',
    )
    expect(ruleById('loose-jwt').prefilter?.source).toBe('eyJ')
  })

  test('gcp-service-account local part is bounded to {1,64}', () => {
    expect(ruleById('gcp-service-account').source).toBe(
      '\\b([a-z0-9-]{1,64}@[a-z0-9-]+\\.iam\\.gserviceaccount\\.com)\\b',
    )
  })

  test('anthropic-oauth-token source + run field are byte-exact', () => {
    const rule = ruleById('anthropic-oauth-token')
    expect(rule.source).toBe(
      '\\b(sk-ant-(?:oat|ort)\\d{2}-[\\w-]{20,})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
    )
    expect(rule.run).toBe('[\\w-]')
  })

  test('all 11 gitlab rules carry the displayRun field', () => {
    const gitlab = St.filter((r) => r.id.startsWith('gitlab-'))
    expect(gitlab.length).toBe(11)
    for (const rule of gitlab) expect(rule.displayRun).toBe('[\\w=-]')
  })

  test('anthropic-api-key source is byte-exact', () => {
    expect(ruleById('anthropic-api-key').source).toBe(
      '\\b(sk-ant-api03-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
    )
  })
})

describe('no regression on previously-redacted samples', () => {
  test('plain password assignment still redacts', () => {
    expect(redactSecrets('password = "Sup3rSecretPass!"')).not.toContain('Sup3rSecretPass')
  })

  test('URL userinfo still redacts', () => {
    expect(redactSecrets('https://user:pass123@example.com/path')).not.toContain('pass123')
  })

  test('high-confidence provider token still redacts', () => {
    expect(redactSecrets('key ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok')).not.toContain(
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    )
  })

  test('capped redaction still redacts', () => {
    expect(redactSecretsWithCap('password = "abc123secretvalue"', 100000)).not.toContain(
      'abc123secretvalue',
    )
  })
})
