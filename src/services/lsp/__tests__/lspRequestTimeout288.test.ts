import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  resolveRequestTimeoutMs,
} from '../requestTimeout.js'
import { createLSPClient } from '../LSPClient.js'
import { createLSPServerInstance } from '../LSPServerInstance.js'

/**
 * Official v288 (gap-report cluster-f #55): LSP requests time out after a
 * per-server `requestTimeout` (default 60000 ms) instead of hanging forever
 * when a language server stops responding / stalls on dynamic capability
 * registration.
 *
 * Byte-faithful official surface:
 * - zod field: `requestTimeout: z.number().int().positive().max(2147483647).optional()`
 * - describe:  "Maximum time to wait for the server to answer a request (milliseconds). Defaults to 60000."
 * - runtime error text: `Request has exceeded the configured ${ms} ms requestTimeout.`
 *
 * No mock.module here on purpose: Bun's mocks leak across test files in the
 * same worker and src/services/lsp/__tests__/lspClientStop.test.ts mocks the
 * same modules. These tests instead spawn a REAL hanging fake LSP server
 * (fixtures/hangingLspServer.fixture.ts) over stdio — a true e2e of the
 * timeout path.
 */

const HANGING_SERVER_FIXTURE = new URL(
  './fixtures/hangingLspServer.fixture.ts',
  import.meta.url,
).pathname

/** Small per-test timeout so tests stay fast; the default is asserted separately. */
const TEST_REQUEST_TIMEOUT_MS = 150

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error as Error,
  )
  expect(outcome).toBeInstanceOf(Error)
  return outcome as Error
}

describe('2.1.288 #55 — LSPClient.sendRequest timeout (real hanging server)', () => {
  test('a hanging server makes sendRequest reject with the official timeout message', async () => {
    // Arrange — real process, real JSON-RPC over stdio; the server answers
    // `initialize` but never answers `textDocument/hover`.
    const client = createLSPClient(
      'hang-server',
      undefined,
      TEST_REQUEST_TIMEOUT_MS,
    )
    await client.start(process.execPath, [HANGING_SERVER_FIXTURE])
    try {
      await client.initialize({} as never)
      const startedAt = Date.now()

      // Act
      const error = await captureRejection(
        client.sendRequest('textDocument/hover', {}),
      )

      // Assert — exact official runtime error text, fired after the configured ms
      expect(error.message).toBe(
        `Request has exceeded the configured ${TEST_REQUEST_TIMEOUT_MS} ms requestTimeout.`,
      )
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
        TEST_REQUEST_TIMEOUT_MS - 20,
      )
    } finally {
      await client.stop()
    }
  }, 15000)

  test('an answering server still resolves normally through the timeout wrapper', async () => {
    // Arrange
    const client = createLSPClient(
      'hang-server',
      undefined,
      TEST_REQUEST_TIMEOUT_MS,
    )
    await client.start(process.execPath, [HANGING_SERVER_FIXTURE])
    try {
      // Act — `initialize` is answered by the fixture
      const result = await client.initialize({} as never)

      // Assert
      expect(result).toEqual({ capabilities: {} })
      expect(client.isInitialized).toBe(true)
    } finally {
      await client.stop()
    }
  }, 15000)
})

describe('2.1.288 #55 — LSPServerInstance wiring (real hanging server)', () => {
  test('config.requestTimeout is armed end-to-end through the instance', async () => {
    // Arrange
    const instance = createLSPServerInstance('hang-instance', {
      command: process.execPath,
      args: [HANGING_SERVER_FIXTURE],
      requestTimeout: TEST_REQUEST_TIMEOUT_MS,
    })
    await instance.start()
    try {
      // Act
      const error = await captureRejection(
        instance.sendRequest('textDocument/hover', {}),
      )

      // Assert — the instance wraps with context; the official text is inside
      expect(error.message).toContain(
        `Request has exceeded the configured ${TEST_REQUEST_TIMEOUT_MS} ms requestTimeout.`,
      )
    } finally {
      await instance.stop()
    }
  }, 15000)
})

describe('2.1.288 #55 — requestTimeout config resolution', () => {
  test('default requestTimeout is 60000 ms when unset (config resolution, no real waiting)', () => {
    // Official describe: "Defaults to 60000." — applies even when unset.
    expect(DEFAULT_LSP_REQUEST_TIMEOUT_MS).toBe(60000)
    expect(resolveRequestTimeoutMs({})).toBe(60000)
    expect(resolveRequestTimeoutMs(undefined)).toBe(60000)
    expect(resolveRequestTimeoutMs({ requestTimeout: undefined })).toBe(60000)
  })

  test('an explicitly configured requestTimeout is honored within the official zod bounds', () => {
    expect(resolveRequestTimeoutMs({ requestTimeout: 1234 })).toBe(1234)
    // Official zod bounds: int().positive().max(2147483647)
    expect(resolveRequestTimeoutMs({ requestTimeout: 1 })).toBe(1)
    expect(resolveRequestTimeoutMs({ requestTimeout: 2147483647 })).toBe(
      2147483647,
    )
  })

  test('invalid requestTimeout values fall back to the 60000 ms default', () => {
    expect(resolveRequestTimeoutMs({ requestTimeout: 0 })).toBe(60000)
    expect(resolveRequestTimeoutMs({ requestTimeout: -5 })).toBe(60000)
    expect(resolveRequestTimeoutMs({ requestTimeout: 1.5 })).toBe(60000)
    expect(resolveRequestTimeoutMs({ requestTimeout: 2147483648 })).toBe(60000)
    expect(resolveRequestTimeoutMs({ requestTimeout: '60000' })).toBe(60000)
    expect(resolveRequestTimeoutMs({ requestTimeout: null })).toBe(60000)
  })
})

describe('2.1.288 #55 — LspServerConfigSchema requestTimeout field', () => {
  test('validates like the official zod shape and carries the official describe string', async () => {
    // Arrange
    const { LspServerConfigSchema } = await import(
      '../../../utils/plugins/schemas.js'
    )
    const base = {
      command: 'lang-server',
      extensionToLanguage: { '.ts': 'typescript' },
    }

    // Act & Assert — accepted values (int, positive, <= 2147483647)
    for (const valid of [1, 60000, 2147483647]) {
      const result = LspServerConfigSchema().safeParse({
        ...base,
        requestTimeout: valid,
      })
      expect(result.success).toBe(true)
    }

    // Rejected values
    for (const invalid of [0, -5, 1.5, 2147483648, '60000']) {
      const result = LspServerConfigSchema().safeParse({
        ...base,
        requestTimeout: invalid,
      })
      expect(result.success).toBe(false)
    }

    // Omitted is fine (optional)
    expect(LspServerConfigSchema().safeParse(base).success).toBe(true)

    // Official describe string, verbatim
    const field = LspServerConfigSchema().shape.requestTimeout as unknown as {
      _zod?: { def?: { description?: string } }
      description?: string
    }
    const description = field?._zod?.def?.description ?? field?.description
    expect(description).toBe(
      'Maximum time to wait for the server to answer a request (milliseconds). Defaults to 60000.',
    )
  })
})
