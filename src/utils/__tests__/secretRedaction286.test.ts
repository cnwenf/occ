/**
 * Tests for the ported official Claude Code 2.1.286 secret-redaction engine
 * (src/utils/secretRedaction), covering changelog bullets #17-#21:
 *
 *  #17 MCP error messages showing a credential's value when "Bearer"/"Basic"
 *      came BEFORE its key name
 *  #18 percent-encoded Bearer tokens only partly masked
 *  #19 secrets whose key name contains an invisible character (zero-width)
 *  #20 URL passwords with punctuation: ")", quotes, "]", "&", a second "@",
 *      or running past "/" into a bracketed host like [::1] in ssh URLs
 *  #21 transcript JSONL staying valid JSON after redaction (parse ->
 *      deep-redact -> re-serialize; api-request lines dropped/withheld)
 *
 * Strings are built with String.fromCharCode / JSON.stringify / repeat so no
 * escape sequences or invisible characters are typed literally in this file.
 */
import { describe, expect, test } from 'bun:test'
import {
  redactCredentialKeys,
  redactJsonlLines,
  redactJsonStructural,
  redactJsonValue,
  redactSecrets,
  redactTranscriptJsonl,
  scanSecrets,
} from '../secretRedaction/index.js'

const NL = String.fromCharCode(10)
const ZWSP = String.fromCharCode(0x200b)
const TOKEN32 = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'
const SECRET24 = 'ABCDEFGHIJKLMNOPQRSTUVWX'

describe('secretRedaction286: core engine sanity', () => {
  test('redacts a GitHub PAT and labels it via scanSecrets', () => {
    const pat = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const text = 'clone with ' + pat + ' now'
    expect(redactSecrets(text)).not.toContain(pat)
    expect(redactSecrets(text)).toContain('[REDACTED]')
    const found = scanSecrets(text)
    expect(found.some(m => m.ruleId === 'github-pat')).toBe(true)
    expect(found.some(m => m.label === 'GitHub PAT')).toBe(true)
  })

  test('redacts PEM private key blocks', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----' +
      NL +
      'QUJDREVG'.repeat(20) +
      NL +
      '-----END PRIVATE KEY-----'
    const out = redactSecrets('before ' + pem + ' after')
    expect(out).not.toContain('QUJDREVG')
    expect(out).toContain('[REDACTED]')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  test('redacts key=value assignments (sensitive-assign rule)', () => {
    const out = redactSecrets('password = "hunter2xhunter2xhunter"')
    expect(out).not.toContain('hunter2xhunter2xhunter')
  })
})

describe('secretRedaction286: bullet #17 Bearer/Basic before key name', () => {
  test('masks a token that follows Bearer directly', () => {
    const out = redactSecrets('MCP error: auth failed for Bearer ' + TOKEN32)
    expect(out).not.toContain(TOKEN32)
    expect(out).toContain('[REDACTED]')
  })

  test('masks a token that follows Basic directly', () => {
    const out = redactSecrets('WWW-Authenticate rejected Basic ' + TOKEN32)
    expect(out).not.toContain(TOKEN32)
  })

  test('masks a token when Bearer comes before the key name', () => {
    const out = redactSecrets(
      'header Bearer api_key=' + SECRET24 + ' was rejected',
    )
    expect(out).not.toContain(SECRET24)
  })
})

describe('secretRedaction286: bullet #18 percent-encoded tokens', () => {
  test('fully masks a percent-encoded Bearer token value', () => {
    const encoded = 'abc%2Fdef%2Bghi%2Fjklmnopqrstuvwxyz'
    const out = redactSecrets('access_token=' + encoded + ' expired')
    expect(out).not.toContain('def%2Bghi')
    expect(out).not.toContain(encoded)
    expect(out).toContain('[REDACTED]')
  })

  test('masks percent-encoded URL userinfo passwords', () => {
    const out = redactSecrets(
      'dial https://alice:p%40ss%2Fword99@db.internal.example:5432/app failed',
    )
    expect(out).not.toContain('p%40ss%2Fword99')
    expect(out).not.toContain('ss%2Fword99')
  })
})

describe('secretRedaction286: bullet #19 invisible chars in key names', () => {
  test('redacts value when a zero-width space hides inside the key name', () => {
    const key = 'api' + ZWSP + 'key'
    const out = redactSecrets(key + ' = "ZWSECRETVALUE123456789"')
    expect(out).not.toContain('ZWSECRETVALUE123456789')
    expect(out).toContain('[REDACTED]')
  })

  test('redacts value when a soft hyphen hides inside the key name', () => {
    const softHyphen = String.fromCharCode(0x00ad)
    const key = 'pass' + softHyphen + 'word'
    const out = redactSecrets(key + ': PASSWDVALUE987654321xyz')
    expect(out).not.toContain('PASSWDVALUE987654321xyz')
  })

  test('redacts token when a zero-width char hides inside Bearer', () => {
    const out = redactSecrets(
      'auth Bear' + ZWSP + 'er ' + TOKEN32 + ' rejected',
    )
    expect(out).not.toContain(TOKEN32)
  })
})

describe('secretRedaction286: bullet #20 URL passwords with punctuation', () => {
  test('masks a password containing ")"', () => {
    const out = redactSecrets('open https://alice:p)a)s)s1@host.example/x')
    expect(out).not.toContain('p)a)s)s1')
  })

  test('masks a password containing "&"', () => {
    const out = redactSecrets('open https://alice:pa&ssword2@host.example/x')
    expect(out).not.toContain('pa&ssword2')
  })

  test('masks a quoted password', () => {
    const out = redactSecrets('open https://alice:"qpass3"@host.example/x')
    expect(out).not.toContain('qpass3')
  })

  test('masks the full userinfo when a second @ appears', () => {
    const out = redactSecrets(
      'open https://alice:first4@second5@host.example/x',
    )
    expect(out).not.toContain('second5')
    expect(out).not.toContain('first4@second5')
  })

  test('masks a password containing "]"', () => {
    const out = redactSecrets('open https://alice:pa]ss6@host.example/x')
    expect(out).not.toContain('pa]ss6')
  })

  test('masks a password running past / into a bracketed host (ssh URL)', () => {
    const out = redactSecrets('dial ssh://alice:pass7/word8@[::1]:22/repo')
    expect(out).not.toContain('pass7/word8')
    expect(out).not.toContain('pass7')
    expect(out).not.toContain('word8')
  })
})

describe('secretRedaction286: bullet #21 JSONL stays valid JSON', () => {
  const secretLine = JSON.stringify({
    type: 'user',
    message: { content: 'my api_key = "' + SECRET24 + '" ok' },
  })
  const apiRequestLine = JSON.stringify({
    type: 'api-request',
    requestId: 'ab12'.repeat(16),
    authorization: 'Bearer ' + TOKEN32,
  })
  const cleanLine = JSON.stringify({
    type: 'assistant',
    message: { content: 'all good' },
  })
  const invalidLine = 'not-json api_key = "PLAINSECRETVALUE123456" tail'
  const brokenApiReqLine = '{"type":"api-request", oops broken'

  test('valid JSON lines remain parseable after transcript redaction', () => {
    const input = [secretLine, apiRequestLine, cleanLine, invalidLine].join(NL)
    const out = redactTranscriptJsonl(input)
    const lines = out.split(NL).filter(l => l !== '')
    // api-request line must be dropped entirely
    expect(lines.length).toBe(3)
    for (const line of [lines[0], lines[1]]) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    expect(out).not.toContain(SECRET24)
    expect(out).not.toContain(TOKEN32)
    expect(lines[1]).toContain('all good')
  })

  test('unparseable line with api-request marker becomes line-withheld JSON', () => {
    // The withhold logic lives in the line filter (hr), which only runs on the
    // redactTranscriptJsonl (wkn) path - zr redacts lines without filtering.
    const out = redactTranscriptJsonl(brokenApiReqLine)
    expect(() => JSON.parse(out)).not.toThrow()
    const parsed = JSON.parse(out)
    expect(parsed.type).toBe('line-withheld')
    expect(parsed.bytes).toBe(Buffer.byteLength(brokenApiReqLine))
  })

  test('unparseable plain line is redacted as text and stays one line', () => {
    const out = redactJsonlLines(invalidLine)
    expect(out).not.toContain('PLAINSECRETVALUE123456')
    expect(out.split(NL).length).toBe(1)
  })

  test('structural deep redaction scrubs 64-hex ids inside api-request text', () => {
    // Upstream Nt semantics: a string that itself mentions "api-request" gets
    // every standalone 64-hex id replaced with [REDACTED].
    const hex64 = 'cd34'.repeat(16)
    const value = { note: 'failed api-request id ' + hex64 }
    const out = redactJsonStructural(value)
    expect(out.note).not.toContain(hex64)
    expect(out.note).toContain('[REDACTED]')
  })

  test('broken api-request JSONL line still gets its 64-hex ids scrubbed', () => {
    const hex64 = 'ef56'.repeat(16)
    const line = '{"type":"api-request","id":"' + hex64 + '" oops'
    const out = redactJsonlLines(line)
    expect(out).not.toContain(hex64)
    expect(out).toContain('[REDACTED]')
  })
})

describe('secretRedaction286: structural / object redaction', () => {
  test('redactJsonValue deep-redacts objects and arrays', () => {
    const out = redactJsonValue({
      headers: { 'x-api-key': 'HEADERSECRET1234567890' },
      count: 42,
      args: ['token=TOKENVALUE987654321abc', 'safe text'],
    })
    expect(out.headers['x-api-key']).toBe('[REDACTED]')
    expect(out.count).toBe(42)
    expect(out.args[0]).not.toContain('TOKENVALUE987654321abc')
    expect(out.args[1]).toBe('safe text')
  })

  test('redactCredentialKeys blanks values whose key names look like credentials', () => {
    const out = redactCredentialKeys({
      api_key: 'x'.repeat(30),
      password: 'y'.repeat(30),
      description: 'keep me',
    })
    expect(out.api_key).toBe('[REDACTED]')
    expect(out.password).toBe('[REDACTED]')
    expect(out.description).toBe('keep me')
  })
})
