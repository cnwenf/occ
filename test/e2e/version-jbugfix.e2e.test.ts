import { describe, expect, test } from 'bun:test'
import { $ } from 'bun'
import { REPO_ROOT } from './helpers'

/**
 * e2e (source-grep): J9 / J10 / J11 / J13 bugfix reconstruction.
 *
 * Strings verified against /tmp/occ-audit/claude.strings (official 2.1.200
 * binary). Touches ONLY:
 *   - J9  (2.1.157): src/services/api/errorUtils.ts + withRetry.ts + claude.ts
 *   - J10 (2.1.176): src/utils/auth.ts + memoize.ts
 *   - J11 (2.1.147): src/services/mcp/client.ts
 *   - J13 (2.1.154): src/history.ts
 */

async function src(path: string): Promise<string> {
  return Bun.file(`${REPO_ROOT}/${path}`).text()
}

describe('J9 (2.1.157): unprocessable images stripped + retried, not crashed', () => {
  test('errorUtils classifies image_unprocessable 400s and strips the block', async () => {
    const f = await src('src/services/api/errorUtils.ts')
    const out = {
      classifier: f.includes('isImageUnprocessableError'),
      // binary's exact message substrings
      couldNotProcess: f.includes('Could not process image'),
      corruptHeader: f.includes('corrupt header'),
      corruptImage: f.includes('corrupt image'),
      prematureEnd: f.includes('premature end'),
      zlibDataError: f.includes('zlib: data error'),
      zeroWidth: f.includes('zero width'),
      zeroHeight: f.includes('zero height'),
      failedToDecode: f.includes('Failed to decode image:'),
      unableToDetermine: f.includes('Unable to determine image format'),
      status400: f.includes('error.status !== 400'),
      stripLastImageBlock: f.includes('stripLastImageBlock'),
    }
    const script = `import(${JSON.stringify(`${REPO_ROOT}/src/services/api/errorUtils.ts`)}).then(()=>console.log('OK')).catch(e=>{console.error(e?.message);process.exit(1)})`
    const parsed = (await $`bun -e ${script}`.quiet()).stdout.toString().trim()
    expect(parsed).toBe('OK')
    expect(out.classifier).toBe(true)
    expect(out.couldNotProcess).toBe(true)
    expect(out.corruptHeader).toBe(true)
    expect(out.corruptImage).toBe(true)
    expect(out.prematureEnd).toBe(true)
    expect(out.zlibDataError).toBe(true)
    expect(out.zeroWidth).toBe(true)
    expect(out.zeroHeight).toBe(true)
    expect(out.failedToDecode).toBe(true)
    expect(out.unableToDetermine).toBe(true)
    expect(out.status400).toBe(true)
    expect(out.stripLastImageBlock).toBe(true)
  })

  test('withRetry strips the block, logs + emits telemetry, retries immediately', async () => {
    const f = await src('src/services/api/withRetry.ts')
    const out = {
      importsClassifier: f.includes('isImageUnprocessableError'),
      stripMediaBlockOption: f.includes('stripMediaBlock'),
      removedLog: f.includes('Removed unprocessable'),
      retryingSuffix: f.includes('; retrying.'),
      telemetry: f.includes('tengu_media_block_strip_retry'),
      bounded: f.includes('MAX_MEDIA_STRIPS'),
      notCounted: f.includes("attempt--"),
    }
    expect(out.importsClassifier).toBe(true)
    expect(out.stripMediaBlockOption).toBe(true)
    expect(out.removedLog).toBe(true)
    expect(out.retryingSuffix).toBe(true)
    expect(out.telemetry).toBe(true)
    expect(out.bounded).toBe(true)
    expect(out.notCounted).toBe(true)
  })

  test('claude.ts wires stripMediaBlock against messagesForAPI', async () => {
    const f = await src('src/services/api/claude.ts')
    const out = {
      importsStrip: f.includes('stripLastImageBlock'),
      wiresCallback: f.includes('stripMediaBlock:') && f.includes('stripLastImageBlock(messagesForAPI)'),
      reassigns: f.includes('messagesForAPI = result.messages'),
    }
    expect(out.importsStrip).toBe(true)
    expect(out.wiresCallback).toBe(true)
    expect(out.reassigns).toBe(true)
  })
})

describe('J10 (2.1.176): Bedrock awsCredentialExport creds cached until Expiration', () => {
  test('auth.ts captures Expiration and computes a per-credential cache TTL', async () => {
    const f = await src('src/utils/auth.ts')
    const out = {
      expirationField: f.includes('expiration?: Date'),
      parsesExpiration: f.includes("new Date(expirationStr)"),
      credsExpirationComment: f.includes('Credentials.Expiration'),
      safetyMargin: f.includes('AWS_CREDENTIAL_EXPIRY_SAFETY_MARGIN_MS'),
      minTtl: f.includes('AWS_CREDENTIAL_MIN_CACHE_TTL_MS'),
      perResultTtl: f.includes('getCacheLifetimeMs') || f.includes('result?.expiration'),
      remaining: f.includes('getTime() - Date.now()'),
    }
    expect(out.expirationField).toBe(true)
    expect(out.parsesExpiration).toBe(true)
    expect(out.credsExpirationComment).toBe(true)
    expect(out.safetyMargin).toBe(true)
    expect(out.minTtl).toBe(true)
    expect(out.perResultTtl).toBe(true)
    expect(out.remaining).toBe(true)
  })

  test('memoize.ts supports per-result TTL override', async () => {
    const f = await src('src/utils/memoize.ts')
    const out = {
      perEntryField: f.includes('cacheLifetimeMs?: number'),
      extractorParam: f.includes('getCacheLifetimeMs?:'),
      usesPerEntry: f.includes('cached.cacheLifetimeMs ?? cacheLifetimeMs'),
      storesOnSet: f.includes('getCacheLifetimeMs?.(result)'),
    }
    expect(out.perEntryField).toBe(true)
    expect(out.extractorParam).toBe(true)
    expect(out.usesPerEntry).toBe(true)
    expect(out.storesOnSet).toBe(true)
  })
})

describe('J11 (2.1.147): stdio MCP servers receive CLAUDECODE=1', () => {
  test('client.ts injects CLAUDECODE into stdio env', async () => {
    const f = await src('src/services/mcp/client.ts')
    // Binary: dft(e){let t={CLAUDECODE:"1",CLAUDE_CODE_SESSION_ID:e.sessionId,...}}
    const hasClaudeCode = f.includes("CLAUDECODE: '1'") || f.includes('CLAUDECODE: "1"')
    const nearSessionId = f.includes('CLAUDE_CODE_SESSION_ID') || f.includes('subprocessEnv()')
    expect(hasClaudeCode).toBe(true)
    expect(nearSessionId).toBe(true)
  })
})

describe('J13 (2.1.154): consecutive duplicate prompts deduped', () => {
  test('history.ts skips consecutive duplicate entries', async () => {
    const f = await src('src/history.ts')
    const out = {
      dedupCheck: f.includes('lastAddedEntry.display === entry.display'),
      consecutiveComment: f.includes('consecutive duplicate'),
      usesLastAdded: f.includes('lastAddedEntry &&'),
    }
    expect(out.dedupCheck).toBe(true)
    expect(out.consecutiveComment).toBe(true)
    expect(out.usesLastAdded).toBe(true)
  })

  test('runtime parse check (no TDZ)', async () => {
    const script = `import(${JSON.stringify(`${REPO_ROOT}/src/history.ts`)}).then(()=>console.log('OK')).catch(e=>{console.error(e?.message);process.exit(1)})`
    const out = (await $`bun -e ${script}`.quiet()).stdout.toString().trim()
    expect(out).toBe('OK')
  })
})
