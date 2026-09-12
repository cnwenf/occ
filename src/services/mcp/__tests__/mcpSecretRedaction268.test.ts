// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every fixture in this file tests literal MCP env-var placeholder strings, not JS templates
/**
 * CC 2.1.268 E16 — MCP secret redaction tests (binary-verified port).
 *
 * Covers the `src/services/mcp/redaction.ts` port of the official 2.1.268
 * machinery (byte offsets in /tmp/cc-diff-268/s2s.txt):
 *   - `JGo` recoverExpandedSecrets (@32576205) incl. all guards
 *   - `ezo` collectConfigSecrets (@32577163)
 *   - `Cat` redactEnvVarPlaceholders / `vte` normalizeEnvVarRefs (@29940100)
 *   - `dt`/`Pe`/`Be` display sanitizers (@32803400)
 *   - `tQn`/`wp`/`bV`/`S` error-detail redaction (@30735025 / @23569500)
 *
 * Handler-level coverage: `mcpGetHandler` prints `display.url` /
 * `display.headers` and `mcpListHandler` prints `displayConfigs[name].url`
 * from exactly the `getDisplayConfig` / `getDisplayServers` copies tested
 * here (src/cli/handlers/mcp.tsx), so asserting on the display copies plus
 * the strings the handlers interpolate from them is the faithful equivalent
 * without booting the CLI (which would connect to real servers).
 */
import { afterEach, describe, expect, test } from 'bun:test'

import type { McpServerConfig, ScopedMcpServerConfig } from '../types.js'
import {
  MCP_ENDPOINT_PLACEHOLDER,
  MCP_ERROR_REDACTION_FAILED,
  type UnexpandedScopeResolver,
  authoredMatchesExpanded,
  clearAuthoredUnexpandedRegistry,
  collectConfigSecrets,
  deepNormalizeEnvVarRefs,
  escapeRegExp,
  getAuthoredUnexpanded,
  getAuthoredUnexpandedRegistry,
  getDisplayConfig,
  getDisplayServers,
  getEndpointForDisplay,
  getMcpErrorEndpoint,
  getUrlOrigin,
  hasEnvVarRefs,
  isLabelLikeSecret,
  maskUrlUserinfo,
  matchesEnvVarTemplate,
  normalizeEnvVarRefs,
  recoverExpandedSecrets,
  redactEnvVarPlaceholders,
  redactMcpErrorDetail,
  redactMcpErrorText,
  registerAuthoredUnexpandedConfig,
  sanitizeConfigForDisplay,
  splitEnvVarSegments,
  splitUrlParts,
} from '../redaction.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const httpExpanded = {
  type: 'http',
  url: 'https://real.host.test/mcp',
  headers: { Authorization: 'Bearer ghp_secretvalue123' },
  scope: 'user',
} as ScopedMcpServerConfig

const httpAuthored = {
  type: 'http',
  url: 'https://${API_HOST}/mcp',
  headers: { Authorization: 'Bearer ${API_TOKEN}' },
  scope: 'user',
} as ScopedMcpServerConfig

/** Resolver serving a single authored copy in `user` scope. */
const resolverWithAuthored: UnexpandedScopeResolver = scope =>
  scope === 'user' ? { github: httpAuthored } : undefined

const emptyResolver: UnexpandedScopeResolver = () => undefined

afterEach(() => {
  clearAuthoredUnexpandedRegistry()
})

// ---------------------------------------------------------------------------
// Env-placeholder primitives (Yce / aX / Tat / Cat / vte)
// ---------------------------------------------------------------------------

describe('env-placeholder primitives', () => {
  test('hasEnvVarRefs detects ${VAR} and ${VAR:-default}', () => {
    expect(hasEnvVarRefs('Bearer ${TOKEN}')).toBe(true)
    expect(hasEnvVarRefs('${TOKEN:-fallback}')).toBe(true)
    expect(hasEnvVarRefs('no placeholders here')).toBe(false)
    // ${user_config.X} has a dot → NOT matched by Yce (same as official)
    expect(hasEnvVarRefs('${user_config.key}')).toBe(false)
  })

  test('splitEnvVarSegments returns literal segments between placeholders', () => {
    expect(splitEnvVarSegments('a${X}b${Y}c')).toEqual(['a', 'b', 'c'])
    expect(splitEnvVarSegments('${X}')).toEqual(['', ''])
    expect(splitEnvVarSegments('plain')).toEqual(['plain'])
  })

  test('redactEnvVarPlaceholders masks with same-length x run (Cat)', () => {
    const masked = redactEnvVarPlaceholders('${API_KEY}')
    expect(masked).toBe('xxxxxxxxxx')
    expect(masked.length).toBe('${API_KEY}'.length)
    expect(redactEnvVarPlaceholders('pre ${A:-def} post')).toBe(
      `pre ${'x'.repeat('${A:-def}'.length)} post`,
    )
    expect(redactEnvVarPlaceholders('plain')).toBe('plain')
  })

  test('normalizeEnvVarRefs collapses :-default to bare ${VAR} (vte)', () => {
    expect(normalizeEnvVarRefs('${API_KEY:-fallback}')).toBe('${API_KEY}')
    expect(normalizeEnvVarRefs('${A:-b}${C}')).toBe('${A}${C}')
    expect(normalizeEnvVarRefs('${A}')).toBe('${A}')
  })

  test('escapeRegExp escapes regex metacharacters (bc)', () => {
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c')
    expect(new RegExp(escapeRegExp('${X}')).test('${X}')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// recoverExpandedSecrets (JGo)
// ---------------------------------------------------------------------------

describe('recoverExpandedSecrets (JGo @32576205)', () => {
  test('single placeholder recovers the expanded value', () => {
    expect(recoverExpandedSecrets('Bearer ${TOKEN}', 'Bearer sk-secret-123')).toEqual([
      'sk-secret-123',
    ])
    expect(recoverExpandedSecrets('${TOKEN}', 'sk-secret-123')).toEqual([
      'sk-secret-123',
    ])
  })

  test(':-default placeholders recover like bare ones', () => {
    expect(recoverExpandedSecrets('${TOKEN:-fallback}', 'secretvalue')).toEqual([
      'secretvalue',
    ])
    expect(
      recoverExpandedSecrets('Bearer ${TOKEN:-none}', 'Bearer secretvalue'),
    ).toEqual(['secretvalue'])
  })

  test('two placeholders recover both values (3-segment path)', () => {
    expect(recoverExpandedSecrets('${A}/${B}', 'xxx/yyy')).toEqual(['xxx', 'yyy'])
  })

  test('duplicate recovered secrets are deduped (K inference)', () => {
    expect(recoverExpandedSecrets('${T}/${T}', 'abc/abc')).toEqual(['abc'])
  })

  test('three placeholders (4-segment anchored regex path)', () => {
    expect(recoverExpandedSecrets('${A}-${B}-${C}', 'one-two-three')).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  test('guards: empty inputs / no "${" / <2 segments → []', () => {
    expect(recoverExpandedSecrets('', 'x')).toEqual([])
    expect(recoverExpandedSecrets('${A}', '')).toEqual([])
    expect(recoverExpandedSecrets('plaintext', 'plaintext')).toEqual([])
    // template with a $ but no full placeholder → segments.length < 2
    expect(recoverExpandedSecrets('no vars $ here', 'no vars $ here')).toEqual([])
  })

  test('guard: more than 9 segments → []', () => {
    const template = '${A}-${B}-${C}-${D}-${E}-${F}-${G}-${H}-${I}'
    expect(splitEnvVarSegments(template).length).toBe(10)
    expect(recoverExpandedSecrets(template, '1-2-3-4-5-6-7-8-9')).toEqual([])
  })

  test('guard: expanded longer than 2000 chars → []; exactly 2000 works', () => {
    expect(recoverExpandedSecrets('${A}', 'x'.repeat(2001))).toEqual([])
    expect(recoverExpandedSecrets('${A}', 'x'.repeat(2000))).toEqual([
      'x'.repeat(2000),
    ])
  })

  test('adjacent placeholders bail on the >=4-segment path (empty middle)', () => {
    expect(recoverExpandedSecrets('${A}${B}-${C}', 'xy-z')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// collectConfigSecrets (ezo)
// ---------------------------------------------------------------------------

describe('collectConfigSecrets (ezo @32577163)', () => {
  test('recovers from the url pair', () => {
    expect(
      collectConfigSecrets(
        { type: 'http', url: 'https://${HOST}/mcp' },
        { type: 'http', url: 'https://secret.host.test/mcp' },
      ),
    ).toEqual(['secret.host.test'])
  })

  test('recovers from command + index-aligned args', () => {
    const secrets = collectConfigSecrets(
      { command: '${CMD_BIN}', args: ['--key', '${ARG_VAL}'] },
      { command: 'realbin', args: ['--key', 'argvalue'] },
    )
    expect(secrets).toEqual(['realbin', 'argvalue'])
  })

  test('args are aligned by index with min-length (extra args ignored)', () => {
    const secrets = collectConfigSecrets(
      { command: '${BIN}', args: ['${A}'] },
      { command: 'bin', args: ['aval', 'extra'] },
    )
    expect(secrets).toEqual(['bin', 'aval'])
  })

  test('recovers from headers and env pairs', () => {
    expect(
      collectConfigSecrets(
        {
          type: 'http',
          url: 'https://h.test/mcp',
          headers: { Authorization: 'Bearer ${TOK}' },
        },
        {
          type: 'http',
          url: 'https://h.test/mcp',
          headers: { Authorization: 'Bearer tokvalue' },
        },
      ),
    ).toEqual(['tokvalue'])
    expect(
      collectConfigSecrets(
        { command: 'node', env: { TOKEN: '${T}' } },
        { command: 'node', env: { TOKEN: 'envsecret' } },
      ),
    ).toEqual(['envsecret'])
  })

  test('undefined authored → []', () => {
    expect(collectConfigSecrets(undefined, httpExpanded)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Template equivalence (f / Uun) + URL helpers (Pst / We / ie / oe)
// ---------------------------------------------------------------------------

describe('template equivalence and URL helpers', () => {
  test('matchesEnvVarTemplate: single segment requires equality', () => {
    expect(matchesEnvVarTemplate('abc', 'abc')).toBe(true)
    expect(matchesEnvVarTemplate('abc', 'abd')).toBe(false)
  })

  test('matchesEnvVarTemplate: ordered segment containment', () => {
    expect(matchesEnvVarTemplate('https://${H}/x', 'https://a.b/x')).toBe(true)
    expect(matchesEnvVarTemplate('https://${H}/x', 'https://a.b/y')).toBe(false)
    expect(matchesEnvVarTemplate('${A}', 'anything')).toBe(true)
  })

  test('authoredMatchesExpanded: url / command / records', () => {
    expect(authoredMatchesExpanded(httpAuthored, httpExpanded)).toBe(true)
    expect(
      authoredMatchesExpanded(httpAuthored, {
        ...httpExpanded,
        headers: { Authorization: 'Bearer x', Extra: 'y' },
      }),
    ).toBe(false) // env/headers key-count mismatch
    expect(
      authoredMatchesExpanded(
        { command: '${BIN}', args: ['${A}'] },
        { command: 'bin', args: ['a'] },
      ),
    ).toBe(true)
    expect(
      authoredMatchesExpanded({ command: '${BIN}' }, { command: 'bin', args: ['a'] }),
    ).toBe(false)
  })

  test('splitUrlParts splits scheme / authority / rest on the masked copy', () => {
    expect(splitUrlParts('https://user:pw@host.test/p?q#f')).toEqual({
      scheme: 'https://',
      authority: 'user:pw@host.test',
      rest: '/p?q#f',
    })
    // placeholders inside the authority cannot shift the delimiters
    const tpl = 'https://${USER}:${PW}@host.test/mcp'
    const parts = splitUrlParts(tpl, redactEnvVarPlaceholders(tpl))
    expect(parts.authority).toBe('${USER}:${PW}@host.test')
  })

  test('getUrlOrigin / maskUrlUserinfo', () => {
    expect(getUrlOrigin('https://srv.test/mcp')).toBe('https://srv.test')
    expect(getUrlOrigin('not a url')).toBeUndefined()
    // ie STRIPS the userinfo (where the secrets live), keeping scheme+host:
    // `p=e.slice(s+d+1,u)` after `d=o.lastIndexOf("@")` (@20411500, verified)
    expect(maskUrlUserinfo('https://${USER}:${PW}@host.test/mcp')).toBe(
      'https://host.test',
    )
    // no '@' → d===-1 → the whole authority is kept
    expect(maskUrlUserinfo('https://host.test/mcp')).toBe('https://host.test')
    // '@' outside the authority → [unparseable-authority]
    expect(maskUrlUserinfo('https://host.test/p@th')).toBe(
      'https://[unparseable-authority]',
    )
  })

  test('getEndpointForDisplay: authored url endpoint/origin, stdio join', () => {
    expect(
      getEndpointForDisplay({
        authoredUnexpanded: httpAuthored,
        expanded: httpExpanded,
        cliOwned: false,
      }),
    ).toBe('https://${API_HOST}/mcp')
    expect(
      getEndpointForDisplay({
        authoredUnexpanded: httpAuthored,
        expanded: httpExpanded,
        cliOwned: false,
        detail: 'origin',
      }),
    ).toBe('https://${API_HOST}')
    expect(
      getEndpointForDisplay({
        authoredUnexpanded: { command: '${BIN}', args: ['x'] },
        expanded: { command: 'bin', args: ['x'] },
        cliOwned: false,
      }),
    ).toBe('${BIN} x')
    expect(
      getEndpointForDisplay({
        authoredUnexpanded: { command: '${BIN}' },
        expanded: { command: 'bin' },
        cliOwned: false,
        detail: 'origin',
      }),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Display sanitizers (dt / Pe / Be / Wr)
// ---------------------------------------------------------------------------

describe('display sanitizers (dt / Pe / Be @32803400)', () => {
  test('deepNormalizeEnvVarRefs rebuilds nested structures (dt)', () => {
    const source = {
      url: 'https://${H:-d}/x',
      headers: { A: '${T:-f}' },
      args: ['${X:-y}', 'plain'],
    }
    expect(deepNormalizeEnvVarRefs(source)).toEqual({
      url: 'https://${H}/x',
      headers: { A: '${T}' },
      args: ['${X}', 'plain'],
    })
    // immutable: the source object is untouched
    expect(source.headers.A).toBe('${T:-f}')
  })

  test('sanitizeConfigForDisplay degrades url/headers (Pe, http)', () => {
    const display = sanitizeConfigForDisplay(httpExpanded)
    expect(display.url).toBe('http')
    expect(display.headers).toEqual({ Authorization: '[REDACTED]' })
    expect(JSON.stringify(display)).not.toContain('ghp_secretvalue123')
    expect(JSON.stringify(display)).not.toContain('real.host.test')
  })

  test('sanitizeConfigForDisplay degrades command/args/env (Pe, stdio)', () => {
    const display = sanitizeConfigForDisplay({
      command: '/usr/bin/tool',
      args: ['--token', 'tokvalue123'],
      env: { TOKEN: 'supersecretvalue' },
      scope: 'user',
    } as ScopedMcpServerConfig)
    expect(display.command).toBe('stdio')
    expect(display.args).toEqual([])
    expect(display.env).toEqual({ TOKEN: '[REDACTED]' })
  })

  test('getDisplayServers uses the authored copy when it template-matches (Be)', () => {
    const display = getDisplayServers(
      { github: httpExpanded },
      resolverWithAuthored,
    )
    expect(display.github).toEqual(httpAuthored) // dt-normalized (no :-defaults)
    expect(JSON.stringify(display)).not.toContain('ghp_secretvalue123')
    expect(JSON.stringify(display)).not.toContain('real.host.test')
  })

  test('getDisplayServers falls back to Pe when no authored copy matches', () => {
    const display = getDisplayServers({ github: httpExpanded }, emptyResolver)
    expect(display.github.url).toBe('http')
    expect(display.github.headers).toEqual({ Authorization: '[REDACTED]' })
  })

  test('getDisplayServers: claudeai deep-normalizes, unknown scope passes through', () => {
    const claudeai = {
      type: 'claudeai-proxy',
      url: 'https://x.test/${P:-d}',
      id: 'conn1',
      scope: 'claudeai',
    } as ScopedMcpServerConfig
    const unknown = {
      type: 'http',
      url: 'https://srv.test/mcp',
      scope: 'weird',
    } as unknown as ScopedMcpServerConfig
    const display = getDisplayServers(
      { c: claudeai, u: unknown },
      emptyResolver,
    )
    expect(display.c.url).toBe('https://x.test/${P}')
    expect(display.u).toBe(unknown) // same reference — untouched passthrough
  })

  test('getDisplayConfig mirrors the Wr single-server line', () => {
    const display = getDisplayConfig('github', httpExpanded, resolverWithAuthored)
    expect(display).toEqual(httpAuthored)
    const fallback = getDisplayConfig('github', httpExpanded, emptyResolver)
    expect(fallback.url).toBe('http')
  })

  test('handler-level: mcpGetHandler output lines show masked placeholders, not values', () => {
    // mcpGetHandler (src/cli/handlers/mcp.tsx) prints exactly these fields
    // from getDisplayConfig's copy.
    const display = getDisplayConfig('github', httpExpanded, resolverWithAuthored)
    const printed = [
      `URL: ${'url' in display ? display.url : ''}`,
      ...Object.entries(('headers' in display && display.headers) || {}).map(
        ([key, value]) => `Header: ${key}: ${value}`,
      ),
    ].join('\n')
    expect(printed).toContain('https://${API_HOST}/mcp')
    expect(printed).toContain('Bearer ${API_TOKEN}')
    expect(printed).not.toContain('ghp_secretvalue123')
    expect(printed).not.toContain('real.host.test')
  })

  test('handler-level: mcpListHandler output lines show masked placeholders, not values', () => {
    // mcpListHandler prints `${name}: ${server.url} (HTTP: ${url}) - ${status}`
    // from getDisplayServers' copies.
    const displayConfigs = getDisplayServers(
      { github: httpExpanded },
      resolverWithAuthored,
    )
    const server = displayConfigs.github
    const printed = `github: ${'url' in server ? server.url : ''} (HTTP) - connected`
    expect(printed).toBe('github: https://${API_HOST}/mcp (HTTP) - connected')
    expect(printed).not.toContain('real.host.test')
  })
})

// ---------------------------------------------------------------------------
// Authored lookup (S) + registry + endpoint (bV)
// ---------------------------------------------------------------------------

describe('getAuthoredUnexpanded (S) / registry / getMcpErrorEndpoint (bV)', () => {
  test('returns the authored copy only when it template-matches', () => {
    expect(getAuthoredUnexpanded('github', httpExpanded, resolverWithAuthored)).toBe(
      httpAuthored,
    )
    expect(getAuthoredUnexpanded('other', httpExpanded, resolverWithAuthored)).toBe(
      undefined,
    )
    expect(
      getAuthoredUnexpanded('github', httpExpanded, () => {
        throw new Error('config file exploded')
      }),
    ).toBe(undefined) // try/catch swallowed
    // no scope on the config → unknown scope → undefined
    expect(
      getAuthoredUnexpanded(
        'github',
        { type: 'http', url: 'https://real.host.test/mcp' },
        resolverWithAuthored,
      ),
    ).toBe(undefined)
  })

  test('dynamic-scope registry round-trip', () => {
    const authored = { command: '${BIN}', scope: 'dynamic' } as ScopedMcpServerConfig
    registerAuthoredUnexpandedConfig('dyn', authored)
    expect(getAuthoredUnexpandedRegistry().get('dyn')).toBe(authored)
    const dynamicResolver: UnexpandedScopeResolver = scope =>
      scope === 'dynamic'
        ? Object.fromEntries(getAuthoredUnexpandedRegistry())
        : undefined
    expect(
      getAuthoredUnexpanded(
        'dyn',
        { command: 'realbin', scope: 'dynamic' } as ScopedMcpServerConfig,
        dynamicResolver,
      ),
    ).toBe(authored)
    clearAuthoredUnexpandedRegistry()
    expect(getAuthoredUnexpandedRegistry().size).toBe(0)
  })

  test('bV: known scope without authored match → undefined (origin) / type label', () => {
    expect(
      getMcpErrorEndpoint('srv', httpExpanded, { detail: 'origin' }, emptyResolver),
    ).toBeUndefined()
    expect(
      getMcpErrorEndpoint('srv', httpExpanded, { detail: 'endpoint' }, emptyResolver),
    ).toBe('http')
    expect(
      getMcpErrorEndpoint('srv', httpExpanded, undefined, emptyResolver),
    ).toBe('http')
  })

  test('bV: authored match → normalized endpoint / masked origin', () => {
    expect(
      getMcpErrorEndpoint(
        'github',
        httpExpanded,
        { detail: 'origin' },
        resolverWithAuthored,
      ),
    ).toBe('https://${API_HOST}')
    expect(
      getMcpErrorEndpoint(
        'github',
        httpExpanded,
        { detail: 'endpoint' },
        resolverWithAuthored,
      ),
    ).toBe('https://${API_HOST}/mcp')
  })

  test('bV: unknown scope → origin of the expanded url', () => {
    const unscoped = {
      type: 'http',
      url: 'https://srv.test/mcp',
    } as unknown as ScopedMcpServerConfig
    expect(
      getMcpErrorEndpoint('srv', unscoped, { detail: 'origin' }, emptyResolver),
    ).toBe('https://srv.test')
  })
})

// ---------------------------------------------------------------------------
// Label-like classifier (XGo)
// ---------------------------------------------------------------------------

describe('isLabelLikeSecret (XGo)', () => {
  test('label-like strings are detected', () => {
    expect(isLabelLikeSecret('token')).toBe(true)
    expect(isLabelLikeSecret('API_KEY')).toBe(true)
    expect(isLabelLikeSecret('X-Api-Key: ')).toBe(true)
    expect(isLabelLikeSecret('Authorization')).toBe(true)
  })

  test('real secret values are not label-like', () => {
    expect(isLabelLikeSecret('ghp_secretvalue123')).toBe(false)
    expect(isLabelLikeSecret('supersecretvalue')).toBe(false)
    expect(isLabelLikeSecret('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Error-detail redaction (tQn / wp)
// ---------------------------------------------------------------------------

describe('redactMcpErrorText (tQn @30735025)', () => {
  test('endpoint placeholder constant matches the binary', () => {
    expect(MCP_ENDPOINT_PLACEHOLDER).toBe('[mcp-endpoint]')
    expect(MCP_ERROR_REDACTION_FAILED).toBe(
      '[mcp error detail unavailable: redaction failed]',
    )
  })

  test('env secret in error text → [redacted]', () => {
    const config = {
      command: 'node',
      env: { TOKEN: 'supersecretvalue' },
    } as McpServerConfig
    expect(
      redactMcpErrorText('failed: supersecretvalue leaked', config, 'stdio', undefined),
    ).toBe('failed: [redacted] leaked')
  })

  test('command replaced with the display endpoint, word-boundary anchored', () => {
    const config = { command: 'mytool' } as McpServerConfig
    expect(
      redactMcpErrorText('ran mytool-2 and mytool', config, 'stdio', undefined),
    ).toBe('ran mytool-2 and stdio')
  })

  test('secrets shorter than 4 chars are never registered (be guard)', () => {
    const config = { command: 'node', env: { A: 'xy' } } as McpServerConfig
    expect(redactMcpErrorText('xy only', config, 'stdio', undefined)).toBe('xy only')
  })

  test('label-like secrets are skipped (Te guard)', () => {
    const config = { command: 'node', env: { T: 'token' } } as McpServerConfig
    expect(
      redactMcpErrorText('missing token in response', config, 'stdio', undefined),
    ).toBe('missing token in response')
  })

  test('url decomposition: href/origin/host/pathname/search params redacted', () => {
    const config = {
      type: 'http',
      url: 'https://api.secret.test:8443/v1/mcp?key=abc123secret',
    } as McpServerConfig
    const result = redactMcpErrorText(
      'GET https://api.secret.test:8443/v1/mcp?key=abc123secret failed; host api.secret.test port 8443',
      config,
      undefined,
      undefined,
    )
    expect(result).toBe(
      `GET ${MCP_ENDPOINT_PLACEHOLDER} failed; host ${MCP_ENDPOINT_PLACEHOLDER} port 8443`,
    )
    expect(result).not.toContain('abc123secret')
  })

  test('collected secrets + variants are redacted from stdio errors', () => {
    const authored = {
      command: '${BIN}',
      args: ['--token', '${TOK}'],
    } as McpServerConfig
    const expanded = {
      command: '/usr/bin/tool',
      args: ['--token', 'tokvalue123'],
    } as McpServerConfig
    const result = redactMcpErrorText(
      'spawn failed with --token tokvalue123',
      expanded,
      undefined,
      authored,
    )
    expect(result).toBe(`spawn failed with --token [redacted]`)
  })

  test('no registrations → error text returned unchanged', () => {
    const config = { type: 'http', url: 'https://srv.test/mcp' } as McpServerConfig
    expect(redactMcpErrorText('plain failure', config, undefined, undefined)).toBe(
      'plain failure',
    )
  })
})

describe('redactMcpErrorDetail (wp @23569500)', () => {
  test('redacts the expanded url down to the authored template', () => {
    const result = redactMcpErrorDetail(
      'github',
      httpExpanded,
      'ECONNREFUSED https://real.host.test/mcp',
      resolverWithAuthored,
    )
    expect(result).toBe('ECONNREFUSED https://${API_HOST}')
    expect(result).not.toContain('real.host.test')
  })

  test('stdio + env secret with no authored copy → endpoint label + [redacted]', () => {
    const config = {
      command: 'node',
      env: { TOKEN: 'supersecretvalue' },
      scope: 'dynamic',
    } as ScopedMcpServerConfig
    const result = redactMcpErrorDetail(
      'srv',
      config,
      'failed supersecretvalue',
      emptyResolver,
    )
    expect(result).toBe('failed [redacted]')
  })

  test('redaction failure → official fallback string (the only wrapped site)', () => {
    const headers: Record<string, string> = {}
    Object.defineProperty(headers, 'boom', {
      enumerable: true,
      get() {
        throw new Error('header explosion')
      },
    })
    const config = {
      type: 'http',
      url: 'https://ok.test/mcp',
      headers,
      scope: 'user',
    } as ScopedMcpServerConfig
    expect(
      redactMcpErrorDetail('srv', config, 'any error', emptyResolver),
    ).toBe(MCP_ERROR_REDACTION_FAILED)
  })
})
