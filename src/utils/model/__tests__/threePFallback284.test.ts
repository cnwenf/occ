import { NotFoundError } from '@anthropic-ai/sdk'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

/**
 * P3-4 (OCC-101 review, CC 2.1.284 Sonnet 5.5 launch): DUAL-SITE pins for
 * the 3P fallback row claude-sonnet-5-5 → getModelStrings().sonnet5
 * (catalog `fallback_3p:"claude-sonnet-5"`, byte-verified in the v284 ELF).
 *
 * The row exists at TWO independent sites and a launch that only adds one
 * silently degrades the other:
 *   site 1 — validateModel.ts get3PFallbackSuggestion (:226-231): the
 *            /model probe failure message "…not found. Try '<sonnet5>' instead"
 *   site 2 — services/api/errors.ts get3PModelFallbackSuggestion (:1013-1015):
 *            the query-path 404 assistant message "The model … is not
 *            available on your bedrock deployment. Try --model to switch to
 *            <sonnet5>, …"
 *
 * Mock discipline follows sonnet55Launch284.test.ts (P3-8 root fix): real
 * exports are captured in beforeAll (never at module scope — OCC-97 hazard),
 * and bedrock.js getBedrockInferenceProfiles is stubbed to an immediate
 * empty list so the bedrock-env getModelStrings init never fires the real
 * memoized ~2s AWS fetch (session-global STATE pollution class).
 *
 * Mutation self-verification (review protocol): deleting the sonnet-5-5 row
 * in validateModel.ts MUST turn the site-1 pin red; deleting the row in
 * errors.ts MUST turn the site-2 pin red — independently.
 */

process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

const SIDE_QUERY_PATH = '../../sideQuery.js'
const ALLOWLIST_PATH = '../modelAllowlist.js'
const BEDROCK_PATH = '../bedrock.js'
const SETTINGS_PATH = '../../settings/settings.js'

let actualSideQueryExports: Record<string, unknown> = {}
let actualAllowlistExports: Record<string, unknown> = {}
let actualBedrockExports: Record<string, unknown> = {}
let actualSettingsExports: Record<string, unknown> = {}

let probeError: unknown

beforeAll(async () => {
  actualSideQueryExports = { ...((await import(SIDE_QUERY_PATH)) as object) }
  actualAllowlistExports = { ...((await import(ALLOWLIST_PATH)) as object) }
  actualBedrockExports = { ...((await import(BEDROCK_PATH)) as object) }
  actualSettingsExports = { ...((await import(SETTINGS_PATH)) as object) }
  mock.module(SIDE_QUERY_PATH, () => ({
    ...actualSideQueryExports,
    sideQuery: async () => {
      throw probeError
    },
  }))
  mock.module(ALLOWLIST_PATH, () => ({
    ...actualAllowlistExports,
    isModelAllowed: () => true,
  }))
  // P3-8-class hermeticity: never fire the real AWS inference-profile fetch.
  mock.module(BEDROCK_PATH, () => ({
    ...actualBedrockExports,
    getBedrockInferenceProfiles: async () => [],
  }))
  // Hermetic settings: no modelOverrides / enforceAvailableModels influence
  // on getModelStrings.
  mock.module(SETTINGS_PATH, () => ({
    ...actualSettingsExports,
    getSettings_DEPRECATED: () => ({}),
    getInitialSettings: () => ({}),
  }))
})

afterAll(() => {
  // Bun 1.3 mock.restore() does NOT undo mock.module registrations — re-
  // register the real exports explicitly (OCC-97 leak class).
  mock.module(SIDE_QUERY_PATH, () => ({ ...actualSideQueryExports }))
  mock.module(ALLOWLIST_PATH, () => ({ ...actualAllowlistExports }))
  mock.module(BEDROCK_PATH, () => ({ ...actualBedrockExports }))
  mock.module(SETTINGS_PATH, () => ({ ...actualSettingsExports }))
  mock.restore()
})

const { validateModel } = await import('../validateModel.js')
const { getAssistantMessageFromError } = await import(
  '../../../services/api/errors.js'
)
const { getIsInteractive, setIsInteractive } = await import(
  '../../../bootstrap/state.js'
)
const { resetModelStringsForTestingOnly } = await import(
  '../../../bootstrap/state.js'
)

const MODEL = 'claude-sonnet-5-5'
// bedrock provider string for the sonnet-5 fallback (configs.ts
// CLAUDE_SONNET_5_CONFIG.bedrock).
const BEDROCK_SONNET5 = 'us.anthropic.claude-sonnet-5'

function notFound404(): NotFoundError {
  return new NotFoundError(404, { message: 'not found' }, 'not found', undefined)
}

let savedInteractive: boolean
const ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  savedInteractive = getIsInteractive()
  setIsInteractive(false) // deterministic: switchCmd = '--model'
  probeError = undefined
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  setIsInteractive(savedInteractive)
  resetModelStringsForTestingOnly()
})

describe('2.1.284 P3-4 site 1: validateModel 3P fallback suggestion', () => {
  test("bedrock 404 probe suggests the sonnet5 provider string", async () => {
    probeError = notFound404()
    const result = await validateModel(MODEL)
    expect(result.valid).toBe(false)
    expect(result.notFound).toBe(true)
    expect(result.error).toBe(
      `Model '${MODEL}' not found. Try '${BEDROCK_SONNET5}' instead`,
    )
  })

  test('firstParty 404 probe carries NO suggestion (gate before the rows)', async () => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    resetModelStringsForTestingOnly()
    probeError = notFound404()
    const result = await validateModel(MODEL)
    expect(result.valid).toBe(false)
    expect(result.notFound).toBe(true)
    expect(result.error).toBe(`Model '${MODEL}' not found`)
  })
})

describe('2.1.284 P3-4 site 2: query-path 404 assistant message', () => {
  test('bedrock 404 message names the deployment + the sonnet5 fallback', () => {
    const msg = getAssistantMessageFromError(notFound404(), MODEL)
    const text = (msg.message.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain(
      `The model ${MODEL} is not available on your bedrock deployment.`,
    )
    expect(text).toContain(
      `Try --model to switch to ${BEDROCK_SONNET5}, or ask your admin to enable this model.`,
    )
  })

  test('firstParty 404 falls to the generic message (no fallback row)', () => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    resetModelStringsForTestingOnly()
    const msg = getAssistantMessageFromError(notFound404(), MODEL)
    const text = (msg.message.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain(
      `There's an issue with the selected model (${MODEL}).`,
    )
    expect(text).toContain('Run --model to pick a different model.')
    expect(text).not.toContain(BEDROCK_SONNET5)
  })
})
