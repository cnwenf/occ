import { afterAll, describe, expect, mock, test } from 'bun:test'
import { getPluginErrorMessage, type PluginError } from '../../../types/plugin.js'
import {
  fetchPluginZipFromUrl,
  validatePluginZipUrl,
} from '../fetchPluginZip.js'

/**
 * 2.1.275 upstream port (SECURITY, changelog item 3): password/token shown in
 * plugin/marketplace messages, logs, `claude plugin marketplace list`.
 *
 * Each leak site listed in the gap report (report_RESID.md ITEM 3) is
 * exercised here: the constructed message/error must not contain the token.
 * Official v276 references: display scrubber `j6e` @200182994, formatters
 * `z6e` @200183607 / `iZ` @200184648, `kA="[redacted URL]"` @190591150,
 * marketplace-list human path `Source: Git (${j6e(I.url)})` @218230307.
 *
 * OCC-97 discipline: module mocks spread the real module and are restored in
 * afterAll so they don't leak across test files in the same worker.
 */

const TOKEN = 'ghp_SecretToken123'
const CRED_URL = `https://user:${TOKEN}@github.example/owner/repo.git`
const REDACTED = 'https://github.example/owner/repo.git'

// ---------------------------------------------------------------------------
// Leak site 1: src/types/plugin.ts getPluginErrorMessage (was :311/:313/:315/:339)
// ---------------------------------------------------------------------------
describe('getPluginErrorMessage redacts credentials at construction', () => {
  test('git-auth-failed does not leak the gitUrl token', () => {
    const msg = getPluginErrorMessage({
      type: 'git-auth-failed',
      source: 'p@m',
      gitUrl: CRED_URL,
      authType: 'https',
    })
    expect(msg).not.toContain(TOKEN)
    expect(msg).toContain(REDACTED)
  })

  test('git-timeout does not leak the gitUrl token', () => {
    const msg = getPluginErrorMessage({
      type: 'git-timeout',
      source: 'p@m',
      gitUrl: CRED_URL,
      operation: 'clone',
    })
    expect(msg).not.toContain(TOKEN)
    expect(msg).toContain(REDACTED)
  })

  test('network-error does not leak the url token (incl. details sweep)', () => {
    const msg = getPluginErrorMessage({
      type: 'network-error',
      source: 'p@m',
      url: CRED_URL,
      details: `fetch of ${CRED_URL} failed`,
    })
    expect(msg).not.toContain(TOKEN)
    expect(msg).toContain(REDACTED)
  })

  test('mcpb-download-failed does not leak the url token', () => {
    const msg = getPluginErrorMessage({
      type: 'mcpb-download-failed',
      source: 'p@m',
      plugin: 'p',
      url: `https://user:${TOKEN}@host.example/x.mcpb`,
      reason: 'HTTP 403',
    })
    expect(msg).not.toContain(TOKEN)
    expect(msg).toContain('https://host.example/x.mcpb')
  })

  test('generic-error free-form text is swept of embedded credentials', () => {
    const msg = getPluginErrorMessage({
      type: 'generic-error',
      source: 'p@m',
      error: `clone failed for https://user:${TOKEN}@github.example/o/r.git`,
    })
    expect(msg).not.toContain(TOKEN)
    expect(msg).toBe('clone failed for https://github.example/o/r.git')
  })
})

// ---------------------------------------------------------------------------
// Leak site 2: src/commands/plugin/PluginErrors.tsx (was :9-:36)
// ---------------------------------------------------------------------------
describe('formatErrorMessage / getErrorGuidance redact credentials', () => {
  test('git-auth-failed, git-timeout, network-error, mcpb-download-failed', async () => {
    const { formatErrorMessage } = await import(
      '../../../commands/plugin/PluginErrors.js'
    )
    const errors: PluginError[] = [
      { type: 'git-auth-failed', source: 'p@m', gitUrl: CRED_URL, authType: 'ssh' },
      { type: 'git-timeout', source: 'p@m', gitUrl: CRED_URL, operation: 'pull' },
      { type: 'network-error', source: 'p@m', url: CRED_URL },
      {
        type: 'mcpb-download-failed',
        source: 'p@m',
        plugin: 'p',
        url: CRED_URL,
        reason: `download from ${CRED_URL} failed`,
      },
    ]
    for (const error of errors) {
      const msg = formatErrorMessage(error)
      expect(msg).not.toContain(TOKEN)
      expect(msg).toContain('github.example/owner/repo.git')
    }
  })

  test('getErrorGuidance sweeps formatted sources carrying credentials', async () => {
    const { getErrorGuidance } = await import(
      '../../../commands/plugin/PluginErrors.js'
    )
    const guidance = getErrorGuidance({
      type: 'marketplace-blocked-by-policy',
      source: 'p@m',
      marketplace: 'm',
      blockedByBlocklist: false,
      allowedSources: [`git:${CRED_URL}`],
    })
    expect(guidance).not.toBeNull()
    expect(guidance).not.toContain(TOKEN)
    expect(guidance).toContain(`git:${REDACTED}`)
  })
})

// ---------------------------------------------------------------------------
// Leak site 3: src/utils/plugins/mcpPluginIntegration.ts (was :96-:99 + logs)
// ---------------------------------------------------------------------------
const actualMcpb = await import('../mcpbHandler.js')
let mockedLoadMcpbFile: ((...args: unknown[]) => Promise<never>) | undefined
mock.module('../mcpbHandler.js', () => ({
  ...actualMcpb,
  loadMcpbFile: (...args: unknown[]) => {
    if (mockedLoadMcpbFile) return mockedLoadMcpbFile(...args)
    throw new Error('no mock configured')
  },
}))

describe('mcpPluginIntegration error construction redacts MCPB URL credentials', () => {
  const makePlugin = (mcpServers: string) =>
    ({
      name: 'test-plugin',
      manifest: { name: 'test-plugin', version: '1.0.0', mcpServers },
      path: '/nonexistent-plugin-dir',
      source: 'test-plugin@test-market',
      repository: 'test-market',
    }) as never

  test('mcpb-download-failed error object carries a scrubbed url + reason', async () => {
    const mcpbUrl = `https://user:${TOKEN}@host.example/x.mcpb`
    mockedLoadMcpbFile = async () => {
      throw new Error(`download failed for ${mcpbUrl}`)
    }
    const { loadPluginMcpServers } = await import('../mcpPluginIntegration.js')
    const errors: PluginError[] = []
    await loadPluginMcpServers(makePlugin(mcpbUrl), errors)
    expect(errors.length).toBe(1)
    const err = errors[0]
    expect(err.type).toBe('mcpb-download-failed')
    if (err.type !== 'mcpb-download-failed') return
    expect(err.url).toBe('https://host.example/x.mcpb')
    expect(err.url).not.toContain(TOKEN)
    expect(err.reason).not.toContain(TOKEN)
    // and the rendered message is clean end-to-end
    expect(getPluginErrorMessage(err)).not.toContain(TOKEN)
  })

  test('local-path MCPB sources are NOT mangled into [redacted URL]', async () => {
    const localPath = '/tmp/plugins/local.mcpb'
    mockedLoadMcpbFile = async () => {
      throw new Error('manifest invalid')
    }
    const { loadPluginMcpServers } = await import('../mcpPluginIntegration.js')
    const errors: PluginError[] = []
    await loadPluginMcpServers(makePlugin(localPath), errors)
    expect(errors.length).toBe(1)
    const err = errors[0]
    expect(err.type).toBe('mcpb-invalid-manifest')
    if (err.type !== 'mcpb-invalid-manifest') return
    expect(err.mcpbPath).toBe(localPath)
  })
})

// ---------------------------------------------------------------------------
// Leak site 4: src/utils/plugins/fetchPluginZip.ts (was :103-:149)
// ---------------------------------------------------------------------------
describe('fetchPluginZip error messages redact --plugin-url credentials', () => {
  const credZipUrl = `https://user:${TOKEN}@example.com/p.zip`
  const mockResponse = (chunks: Uint8Array[], status = 200): Response => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        controller.close()
      },
    })
    return new Response(stream, {
      status,
      statusText: status === 200 ? 'OK' : '',
    })
  }

  test('invalid-URL message redacts credential-looking unparseable input', () => {
    let message = ''
    try {
      validatePluginZipUrl(`https://user:${TOKEN}@exa mple.com/x.zip`)
    } catch (e) {
      message = String(e)
    }
    expect(message).not.toContain(TOKEN)
    expect(message).toContain('[redacted URL]')
  })

  test('HTTP failure message shows the scrubbed URL', async () => {
    let message = ''
    try {
      await fetchPluginZipFromUrl(credZipUrl, {
        fetchImpl: async () => mockResponse([], 404),
      })
    } catch (e) {
      message = String(e)
    }
    expect(message).not.toContain(TOKEN)
    expect(message).toContain('https://example.com/p.zip')
  })

  test('empty-body and oversize messages show the scrubbed URL', async () => {
    let emptyMsg = ''
    try {
      await fetchPluginZipFromUrl(credZipUrl, {
        fetchImpl: async () => mockResponse([]),
      })
    } catch (e) {
      emptyMsg = String(e)
    }
    expect(emptyMsg).not.toContain(TOKEN)
    expect(emptyMsg).toContain('https://example.com/p.zip')

    let oversizeMsg = ''
    try {
      await fetchPluginZipFromUrl(credZipUrl, {
        maxBytes: 4,
        fetchImpl: async () => mockResponse([new Uint8Array([1, 2, 3, 4, 5])]),
      })
    } catch (e) {
      oversizeMsg = String(e)
    }
    expect(oversizeMsg).not.toContain(TOKEN)
    expect(oversizeMsg).toContain('https://example.com/p.zip')
  })

  test('timeout message shows the scrubbed URL', async () => {
    let message = ''
    const hangingFetch = (
      _url: unknown,
      init: { signal: AbortSignal },
    ): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })
    try {
      await fetchPluginZipFromUrl(credZipUrl, {
        timeoutMs: 40,
        fetchImpl: hangingFetch as unknown as typeof fetch,
      })
    } catch (e) {
      message = String(e)
    }
    expect(message).not.toContain(TOKEN)
    expect(message).toContain('timed out')
    expect(message).toContain('https://example.com/p.zip')
  })

  test('the actual fetch still receives the raw credentials (fetch works, display does not leak)', async () => {
    let seen: URL | undefined
    const result = await fetchPluginZipFromUrl(credZipUrl, {
      fetchImpl: async (input) => {
        seen = input instanceof URL ? input : new URL(String(input))
        return mockResponse([new Uint8Array([1, 2, 3])])
      },
    })
    expect(seen?.username).toBe('user')
    expect(seen?.password).toBe(TOKEN)
    // returned data keeps the raw source (config/fetch data, never rendered)
    expect(result.url).toBe(credZipUrl)
  })
})

// ---------------------------------------------------------------------------
// Leak site 5: `claude plugin marketplace list` human output
// (src/cli/handlers/plugins.ts marketplaceListHandler — official v276 keeps
// --json raw and scrubs only the human list via j6e)
// ---------------------------------------------------------------------------
const actualMm = await import('../marketplaceManager.js')
let mockedConfig: Record<string, unknown> = {}
mock.module('../marketplaceManager.js', () => ({
  ...actualMm,
  loadKnownMarketplacesConfig: async () => mockedConfig,
}))

describe('marketplaceListHandler scrubs the human list, keeps --json raw (official parity)', () => {
  const runHandler = async (options: { json?: boolean }) => {
    const { marketplaceListHandler } = await import(
      '../../../cli/handlers/plugins.js'
    )
    const realExit = process.exit
    const realWrite = process.stdout.write
    const realLog = console.log
    let stdoutBuf = ''
    const logLines: string[] = []
    process.exit = (() => {}) as never
    process.stdout.write = ((chunk: string) => {
      stdoutBuf += chunk
      return true
    }) as never
    console.log = ((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '))
    }) as never
    try {
      await marketplaceListHandler(options)
    } finally {
      process.exit = realExit
      process.stdout.write = realWrite
      console.log = realLog
    }
    return { stdoutBuf, logLines }
  }

  test('human output shows Source: Git/URL scrubbed', async () => {
    mockedConfig = {
      'git-market': {
        source: { source: 'git', url: CRED_URL },
        installLocation: '/tmp/git-market',
      },
      'url-market': {
        source: {
          source: 'url',
          url: `https://user:${TOKEN}@host.example/marketplace.json`,
        },
        installLocation: '/tmp/url-market',
      },
    }
    const { logLines } = await runHandler({})
    const out = logLines.join('\n')
    expect(out).not.toContain(TOKEN)
    expect(out).toContain(`Source: Git (${REDACTED})`)
    expect(out).toContain('Source: URL (https://host.example/marketplace.json)')
  })

  test('--json output keeps the raw url (byte-parity with official v276 `{url:I.url}`)', async () => {
    mockedConfig = {
      'git-market': {
        source: { source: 'git', url: CRED_URL },
        installLocation: '/tmp/git-market',
      },
    }
    const { stdoutBuf } = await runHandler({ json: true })
    // Official v276 emits the raw url in the JSON payload (machine-readable
    // config round-trip); the changelog fix targets the rendered list.
    expect(stdoutBuf).toContain(CRED_URL)
  })
})

afterAll(() => {
  mockedLoadMcpbFile = undefined
  mock.module('../mcpbHandler.js', () => ({ ...actualMcpb }))
  mock.module('../marketplaceManager.js', () => ({ ...actualMm }))
})
