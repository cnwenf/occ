import { APIConnectionError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { formatAPIError } from '../errorUtils.js'

/**
 * CC 2.1.311 (triage-T3 item 60 / WP-S): "Connection dropped" per-code
 * connection-error formatter + the proxy/gateway/VPN advice suffix.
 *
 * Official v311 (`YSe` formatter @241616456 + the server_error construction
 * @250055088, both byte-verified):
 *   let Q=YSe(e),Se="";
 *   if(Q===`${les} (${G})`&&!oYe()&&Te()==="firstParty"
 *      &&i.ANTHROPIC_UNIX_SOCKET===void 0){
 *     let we=YB(),ve=[...we&&!Yy(j2r())?[`the proxy set in ${we.source}`]:[],
 *       ...NFe()!==void 0?["the gateway set in ANTHROPIC_BASE_URL"]:[]];
 *     Se=ve.length>0?`. Check ${ve.join(" and ")}, then try again.`
 *       :". A VPN, firewall, or security software can cause this. Check those or switch networks, then try again."}
 *   return Ws({content:`${ed}: ${Q}${Se}`, ...})   // ed = "API Error"
 *
 * `les`="Connection dropped". The advice suffix attaches ONLY when the
 * formatted message is exactly `Connection dropped (<code>)` (the
 * ECONNRESET/EPIPE/… family) — the ECONNREFUSED/ENOTFOUND/… messages get their
 * own formatter and NO suffix.
 *
 * In OCC the "API Error: " prefix is added by errors.ts (unmodifiable here),
 * and formatAPIError returns the formatted message + suffix; these tests assert
 * both formatAPIError's raw return AND the `API Error: ${...}` composition the
 * errors.ts server_error path produces.
 */

const VPN_ADVICE =
  '. A VPN, firewall, or security software can cause this. Check those or switch networks, then try again.'

const ENV_KEYS = [
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY',
  'no_proxy',
  'NO_PROXY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'USER_TYPE',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

/** An APIConnectionError whose cause chain carries the given socket `code`. */
function connectionError(code: string): APIConnectionError {
  const cause = Object.assign(new Error('socket hang up'), { code })
  return new APIConnectionError({ message: 'Connection error.', cause })
}

/** errors.ts composes the user-facing content as `API Error: ${formatAPIError}`. */
function composedContent(code: string): string {
  return `API Error: ${formatAPIError(connectionError(code))}`
}

describe('2.1.311 item-60 — Connection dropped per-code formatter', () => {
  // Isolate the per-code formatter from the advice suffix (tested separately in
  // the next describe): setting ANTHROPIC_UNIX_SOCKET closes the advice gate, so
  // formatAPIError returns exactly the official `YSe` formatter output. Runs
  // after the outer beforeEach (which clears ENV_KEYS), so it takes effect.
  beforeEach(() => {
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/anthropic.sock'
  })

  test('ECONNRESET → "Connection dropped (ECONNRESET)"', () => {
    expect(formatAPIError(connectionError('ECONNRESET'))).toBe(
      'Connection dropped (ECONNRESET)',
    )
  })

  test.each([
    'ECONNRESET',
    'EPIPE',
    'ECONNABORTED',
    'ConnectionClosed',
    'ERR_SOCKET_CLOSED',
    'UND_ERR_SOCKET',
  ])('%s → Connection dropped (<code>)', code => {
    expect(formatAPIError(connectionError(code))).toBe(
      `Connection dropped (${code})`,
    )
  })

  test('ECONNREFUSED → its own verbatim formatter (em-dash)', () => {
    expect(formatAPIError(connectionError('ECONNREFUSED'))).toBe(
      'Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
    )
  })

  test('ConnectionRefused alias → same formatter as ECONNREFUSED', () => {
    expect(formatAPIError(connectionError('ConnectionRefused'))).toBe(
      'Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)',
    )
  })

  test.each(['ENOTFOUND', 'EAI_AGAIN', 'FailedToOpenSocket'])(
    '%s → Can\'t reach the API server formatter',
    code => {
      expect(formatAPIError(connectionError(code))).toBe(
        `Can't reach the API server — check your internet or DNS (${code})`,
      )
    },
  )

  test.each(['ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN'])(
    '%s → No internet route formatter',
    code => {
      expect(formatAPIError(connectionError(code))).toBe(
        `No internet route — check your connection or VPN (${code})`,
      )
    },
  )

  test('ERR_PROXY_TUNNEL → proxy-tunnel formatter (code before the dash)', () => {
    expect(formatAPIError(connectionError('ERR_PROXY_TUNNEL'))).toBe(
      "Couldn't connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused the tunnel: check its credentials and that it allows this host",
    )
  })

  test('unknown code → default "Unable to connect to API (<code>)"', () => {
    expect(formatAPIError(connectionError('ESOMETHINGNEW'))).toBe(
      'Unable to connect to API (ESOMETHINGNEW)',
    )
  })
})

describe('2.1.311 item-60 — Connection dropped advice suffix', () => {
  test('ECONNRESET, firstParty, no proxy/gateway → VPN/firewall advice (composed with the API Error prefix)', () => {
    expect(composedContent('ECONNRESET')).toBe(
      `API Error: Connection dropped (ECONNRESET)${VPN_ADVICE}`,
    )
  })

  test('ECONNRESET raw formatAPIError return carries the VPN/firewall suffix', () => {
    expect(formatAPIError(connectionError('ECONNRESET'))).toBe(
      `Connection dropped (ECONNRESET)${VPN_ADVICE}`,
    )
  })

  test('ECONNRESET behind a proxy → proxy-source advice', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080'
    expect(formatAPIError(connectionError('ECONNRESET'))).toBe(
      'Connection dropped (ECONNRESET). Check the proxy set in HTTPS_PROXY, then try again.',
    )
  })

  test('lowercase https_proxy wins the source name (fo precedence)', () => {
    process.env.https_proxy = 'http://proxy.corp.example:8080'
    expect(formatAPIError(connectionError('ECONNRESET'))).toBe(
      'Connection dropped (ECONNRESET). Check the proxy set in https_proxy, then try again.',
    )
  })

  test('ECONNRESET behind a custom gateway → gateway advice', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.corp.example'
    expect(formatAPIError(connectionError('ECONNRESET'))).toBe(
      'Connection dropped (ECONNRESET). Check the gateway set in ANTHROPIC_BASE_URL, then try again.',
    )
  })

  test('ECONNRESET behind proxy AND gateway → both joined with " and "', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080'
    process.env.ANTHROPIC_BASE_URL = 'https://gw.corp.example'
    expect(formatAPIError(connectionError('ECONNRESET'))).toBe(
      'Connection dropped (ECONNRESET). Check the proxy set in HTTPS_PROXY and the gateway set in ANTHROPIC_BASE_URL, then try again.',
    )
  })

  test('proxy matched by NO_PROXY → proxy hint dropped, falls back to VPN advice', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080'
    process.env.NO_PROXY = '*'
    expect(formatAPIError(connectionError('ECONNRESET'))).toBe(
      `Connection dropped (ECONNRESET)${VPN_ADVICE}`,
    )
  })

  test('ECONNREFUSED gets NO advice suffix (formatted is not "Connection dropped (code)")', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp.example:8080'
    expect(formatAPIError(connectionError('ECONNREFUSED'))).toBe(
      'Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
    )
  })

  test('ANTHROPIC_UNIX_SOCKET set → advice gate closed (no suffix)', () => {
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/anthropic.sock'
    expect(formatAPIError(connectionError('ECONNRESET'))).toBe(
      'Connection dropped (ECONNRESET)',
    )
  })

  test('non-firstParty provider (Bedrock) → advice gate closed (no suffix)', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(formatAPIError(connectionError('ECONNRESET'))).toBe(
      'Connection dropped (ECONNRESET)',
    )
  })
})
