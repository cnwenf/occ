// CC 2.1.286 (changelog #2): macOS "Not logged in" / "Login expired" after
// /login in another window with a leftover ~/.claude/.credentials.json.
//
// Byte-verified v286 delta (2.1.286 linux-x64 ELF):
//   ik (@199703297 region) — 30s-throttled, firstParty-only recheck invoked
//   from the disk-UNCHANGED branches of the credentials change-checker qk:
//     async function ik(e,n){try{if(!Bn())return;
//       let r=e.promise?await e.promise.catch(()=>null):e.value;
//       if(r===void 0)return;
//       if(r!==null&&!Pf(r))return;
//       let s=Date.now();
//       if(s-e.lastUnusableTokenRecheckAt<PVo)return;
//       if(e.lastUnusableTokenRecheckAt=s,r!==null)
//         e.lastKeychainAccessToken=r.accessToken;
//       await kf(e,n)}catch(r){d(r)}}
//   PVo=30000 (@198913842); Pf (@199702674):
//     function Pf(e){if(e){let n=e.refreshToken;
//       return n===""||!!n&&bi.has(n)}if(lc())return!1;return}
//
// These tests exercise the OCC port in src/utils/auth.ts:
// recheckOAuthTokenIfUnusable (ik), isOAuthTokenUnusable (Pf), and the
// unchanged-disk call site inside invalidateOAuthCacheIfDiskChanged (qk).

import {
  afterAll,
  beforeAll,
  expect,
  spyOn,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearOAuthTokenCache,
  getClaudeAIOAuthTokens,
  invalidateOAuthCacheIfDiskChanged,
  isOAuthTokenUnusable,
  recheckOAuthTokenIfUnusable,
} from '../auth.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'

const RECHECK_THROTTLE_MS = 30_000 // PVo, byte-verified @198913842
const FAR_FUTURE_EXPIRY = Date.now() + 86_400_000
// Fixed, whole-second mtime so statSync().mtimeMs round-trips exactly through
// utimesSync (float-ms mtimes would not survive the Date truncation).
const FIXED_MTIME = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000)

const ENV_TO_CLEAR = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
]

let tmpConfigDir: string
let credPath: string
const savedEnv: Record<string, string | undefined> = {}
let savedConfigDir: string | undefined
let fakeNow = Date.now()
let nowSpy: {
  mock: { calls: unknown[][] }
  mockClear(): void
  mockRestore(): void
}

function writeCred(accessToken: string, refreshToken: string | null): void {
  writeFileSync(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt: FAR_FUTURE_EXPIRY,
        scopes: ['user:inference'],
      },
    }),
  )
  utimesSync(credPath, FIXED_MTIME, FIXED_MTIME)
}

/** Memoize the current disk token as the HELD token (official `e.value`). */
function primeHeldToken(): void {
  clearOAuthTokenCache()
  getClaudeAIOAuthTokens()
}

beforeAll(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-286-recheck-'))
  credPath = join(tmpConfigDir, '.credentials.json')
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  for (const k of ENV_TO_CLEAR) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  getClaudeConfigHomeDir.cache?.clear?.()
  nowSpy = spyOn(Date, 'now').mockImplementation(() => fakeNow)
})

afterAll(() => {
  nowSpy.mockRestore()
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  for (const k of ENV_TO_CLEAR) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  getClaudeConfigHomeDir.cache?.clear?.()
  clearOAuthTokenCache()
  try {
    rmSync(tmpConfigDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup of the tmp fixture
  }
})

test('Pf: empty-string refresh token (leftover-credentials shape) is unusable', () => {
  expect(isOAuthTokenUnusable({ accessToken: 'a', refreshToken: '' })).toBe(true)
  expect(isOAuthTokenUnusable({ accessToken: 'a', refreshToken: 'rt' })).toBe(false)
  expect(isOAuthTokenUnusable({ accessToken: 'a', refreshToken: null })).toBe(false)
})

test('Pf: null token → undefined (bare return), false when host-managed (lc)', () => {
  expect(isOAuthTokenUnusable(null)).toBeUndefined()
  process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  try {
    expect(isOAuthTokenUnusable(null)).toBe(false)
  } finally {
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
  }
})

test('ik: usable held token → no reload, throttle clock not even read', async () => {
  writeCred('held-usable', 'rt-held')
  primeHeldToken()
  writeCred('on-disk-other', 'rt-other')

  nowSpy.mockClear()
  await recheckOAuthTokenIfUnusable()

  // Official ik checks Pf(r) BEFORE Date.now — usable token returns early.
  expect(nowSpy.mock.calls.length).toBe(0)
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe('held-usable')
})

test('ik: cold cache (nothing held) → early return before throttle', async () => {
  writeCred('on-disk-x', 'rt-x')
  clearOAuthTokenCache()

  nowSpy.mockClear()
  await recheckOAuthTokenIfUnusable()

  expect(nowSpy.mock.calls.length).toBe(0)
  // Getter still works afterwards (smoke).
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe('on-disk-x')
})

test('ik: non-firstParty provider → gate returns before any reload (Bn)', async () => {
  writeCred('held-dead-gate', '')
  primeHeldToken()
  writeCred('fresh-on-disk-gate', 'rt-fresh')

  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  try {
    fakeNow += RECHECK_THROTTLE_MS + 1
    nowSpy.mockClear()
    await recheckOAuthTokenIfUnusable()
    expect(nowSpy.mock.calls.length).toBe(0)
    // Held dead token survives — bedrock sessions never run the recheck.
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('held-dead-gate')
  } finally {
    delete process.env.CLAUDE_CODE_USE_BEDROCK
  }
})

test('qk: disk unchanged + dead held token → invalidate rechecks and reloads (leftover-credentials fix)', async () => {
  // Arrange: dead token held (empty refreshToken — the leftover-credentials
  // signature), fresh good token on disk at the SAME mtime (another window's
  // /login that the v285 mtime-only checker could not see).
  writeCred('dead-held', '')
  await invalidateOAuthCacheIfDiskChanged() // primes lastCredentialsMtimeMs (changed branch)
  primeHeldToken()
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe('dead-held')
  writeCred('fresh-good', 'rt-fresh-good') // writeCred restores FIXED_MTIME

  // Act
  fakeNow += RECHECK_THROTTLE_MS + 1
  await invalidateOAuthCacheIfDiskChanged()

  // Assert: recheck cleared the memoize and reloaded from disk.
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe('fresh-good')
})

test('ik: reload is throttled to one per 30s (PVo)', async () => {
  // Arrange: dead token held again; distinct fresh token on disk.
  writeCred('dead-held-2', '')
  primeHeldToken()
  writeCred('fresh-good-2', 'rt-fresh-2')

  // Act 1: 29,999ms after the last reload → throttled, cache untouched.
  fakeNow += RECHECK_THROTTLE_MS - 1
  await recheckOAuthTokenIfUnusable()
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe('dead-held-2')

  // Act 2: cross the 30s boundary → reload happens.
  fakeNow += 2
  await recheckOAuthTokenIfUnusable()
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe('fresh-good-2')
})

test('ik: held null (logged out) + credentials appear → reload ("Not logged in" recovery)', async () => {
  // Arrange: no credentials file — getter memoizes null (logged-out window).
  rmSync(credPath, { force: true })
  clearOAuthTokenCache()
  expect(getClaudeAIOAuthTokens()).toBeNull()

  // Act: another window completes /login; recheck runs after the throttle.
  writeCred('login-elsewhere', 'rt-elsewhere')
  fakeNow += RECHECK_THROTTLE_MS + 1
  await recheckOAuthTokenIfUnusable()

  // Assert: this window sees the new login without a restart.
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe('login-elsewhere')
})
