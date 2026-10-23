/**
 * CC 2.1.309 changelog #37: "Fixed fine-grained tool streaming staying off on
 * Amazon Bedrock when `ANTHROPIC_BEDROCK_BASE_URL` is set to the default
 * `bedrock-runtime.<region>.amazonaws.com` endpoint."
 *
 * Official evidence (linux-x64 ELFs, read-only forensics):
 * - FGTS gate 308 `A6t` @~249594900 vs 309 `N5t` @~250486000 — identical
 *   EXCEPT the bedrock arm:
 *     308: e==="bedrock"&&!a.ANTHROPIC_BEDROCK_BASE_URL&&n?.eagerInputStreaming?.bedrock
 *     309: e==="bedrock"&&jrr()&&n?.eagerInputStreaming?.bedrock
 *   THE DELTA: `!env` → `jrr()` — a SET-but-DEFAULT endpoint now counts.
 * - `function jrr` @BIN309:240757331 (NEW in 309; zero hits in BIN308):
 *     function jrr(){let e=i.ANTHROPIC_BEDROCK_BASE_URL;if(e===void 0)return!0;
 *       return I4r("bedrock",e)&&K.test(new URL(e).hostname.toLowerCase().replace(/\.$/,""))}
 * - own-host verdict `k`/`I4r` + regex table @BIN309:240755400 (exists in
 *   BOTH 308/309):
 *     E="[a-z]{2,4}(?:-[a-z]{2,5})?-[a-z]+-\\d+"            (region)
 *     W="(?:amazonaws\\.(?:com(?:\\.cn)?|eu)|api\\.aws|c2s\\.ic\\.gov|
 *         sc2s\\.sgov\\.gov|cloud\\.adc-e\\.uk|csp\\.hci\\.ic\\.gov)"
 *     K=new RegExp(`\\.(?!us-gov-)${E}\\.(?:vpce\\.)?(?:amazonaws\\.com|api\\.aws)$`)
 *     y(e)=new RegExp(`^(?:vpce-[a-z0-9-]+\\.)?${e}(?:-fips)?\\.${E}\\.(?:vpce\\.)?${W}$`)
 *     bedrock ownHost = y("bedrock(?:-runtime)?")
 *     k: unparsable→"unparsable"; !ownHost→"foreign"; https→"own"; else "insecure"
 *     I4r(p,u) = k(p,u)==="own"
 * - Semantics: unset → true; set → must be an https own bedrock(-runtime)
 *   host AND hostname ends in a COMMERCIAL-region amazonaws.com/api.aws
 *   suffix (K excludes us-gov via `(?!us-gov-)` and excludes .cn/eu/gov
 *   partitions by only admitting amazonaws.com|api.aws).
 *
 * DECLARED DEVIATION (structure): the official bedrock arm is NOT gated by
 * tengu_fgts — it is `jrr() && per-model cfg.eagerInputStreaming.bedrock`
 * (model-catalog capability map @BIN309:240725004). OCC has no per-model
 * eagerInputStreaming table, so per triage-T2 item 37 the bedrock arm reuses
 * OCC's existing tengu_fgts/env flag gate (same shape as OCC's firstParty
 * arm). The jrr predicate itself is ported byte-faithfully.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

// api.ts transitively reaches filesystem.ts (getBundledSkillsRoot reads
// MACRO.VERSION) — same convention as the other src-level suites.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { isDefaultBedrockBaseUrl } from '../providers.js'

const ENV_KEYS = [
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING',
  'ANTHROPIC_BASE_URL',
] as const
const savedEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('CC 2.1.309 #37 isDefaultBedrockBaseUrl — official jrr() @240757331', () => {
  test('unset ANTHROPIC_BEDROCK_BASE_URL → true (default endpoint in use)', () => {
    // Arrange / Act / Assert — jrr: `if(e===void 0)return!0`
    expect(isDefaultBedrockBaseUrl()).toBe(true)
  })

  test('default bedrock-runtime endpoint → true (the changelog case)', () => {
    process.env.ANTHROPIC_BEDROCK_BASE_URL =
      'https://bedrock-runtime.us-east-1.amazonaws.com'
    expect(isDefaultBedrockBaseUrl()).toBe(true)
  })

  test('own-host variants admitted by y("bedrock(?:-runtime)?") → true', () => {
    for (const url of [
      'https://bedrock.us-west-2.amazonaws.com', // bare service name
      'https://bedrock-runtime-fips.us-east-1.amazonaws.com', // -fips
      'https://bedrock-runtime.us-east-1.api.aws', // api.aws partition
      'https://vpce-abc123.bedrock-runtime.us-east-1.vpce.amazonaws.com', // vpce
      'https://bedrock-runtime.eu-west-1.amazonaws.com', // region with dot-count 2
    ]) {
      process.env.ANTHROPIC_BEDROCK_BASE_URL = url
      expect(isDefaultBedrockBaseUrl()).toBe(true)
    }
  })

  test('trailing dot in hostname is stripped before matching (official .replace(/\\.$/,""))', () => {
    process.env.ANTHROPIC_BEDROCK_BASE_URL =
      'https://bedrock-runtime.us-east-1.amazonaws.com.'
    expect(isDefaultBedrockBaseUrl()).toBe(true)
  })

  test('custom/proxy endpoints → false (GH#32742 400-avoidance preserved)', () => {
    for (const url of [
      'https://my-proxy.example.com',
      'https://bedrock-runtime.us-east-1.amazonaws.com.evil.com', // suffix smuggle
      'https://s3.us-east-1.amazonaws.com', // own AWS but not bedrock ownHost
      'https://litellm.internal.corp/bedrock',
    ]) {
      process.env.ANTHROPIC_BEDROCK_BASE_URL = url
      expect(isDefaultBedrockBaseUrl()).toBe(false)
    }
  })

  test('non-https scheme → false (k() "insecure" verdict, I4r requires "own")', () => {
    process.env.ANTHROPIC_BEDROCK_BASE_URL =
      'http://bedrock-runtime.us-east-1.amazonaws.com'
    expect(isDefaultBedrockBaseUrl()).toBe(false)
  })

  test('us-gov regions → false (K negative lookahead `(?!us-gov-)`)', () => {
    for (const url of [
      'https://bedrock-runtime.us-gov-west-1.amazonaws.com',
      'https://bedrock-runtime-fips.us-gov-east-1.amazonaws.com',
    ]) {
      process.env.ANTHROPIC_BEDROCK_BASE_URL = url
      expect(isDefaultBedrockBaseUrl()).toBe(false)
    }
  })

  test('non-commercial partitions (.cn / eu / gov-cloud suffixes) → false (K admits only amazonaws.com|api.aws)', () => {
    for (const url of [
      'https://bedrock-runtime.cn-north-1.amazonaws.com.cn',
      'https://bedrock-runtime.eu-isoe-west-1.amazonaws.eu',
    ]) {
      process.env.ANTHROPIC_BEDROCK_BASE_URL = url
      expect(isDefaultBedrockBaseUrl()).toBe(false)
    }
  })

  test('unparsable / empty values → false (k() "unparsable" verdict)', () => {
    for (const url of ['not-a-url', '', 'https://']) {
      process.env.ANTHROPIC_BEDROCK_BASE_URL = url
      expect(isDefaultBedrockBaseUrl()).toBe(false)
    }
  })
})

describe('CC 2.1.309 #37 FGTS gate — eager_input_streaming on Bedrock default endpoint', () => {
  // The gate lives inside toolToAPISchema's cached-base block (api.ts:221+);
  // drive the production serializer with a minimal fake tool. Unique names +
  // clearToolSchemaCache per test keep the session cache from leaking state.
  let toolSeq = 0

  async function serializeProbeTool(): Promise<{
    eager_input_streaming?: boolean
  }> {
    const { toolToAPISchema } = await import('../../../utils/api.js')
    const { getEmptyToolPermissionContext } = await import(
      '../../../Tool.js'
    )
    const tool = {
      name: `fgts309-probe-${toolSeq++}`,
      inputJSONSchema: { type: 'object', properties: {} },
      isMcp: false,
      async prompt() {
        return 'probe tool description'
      },
    }
    const schema = await toolToAPISchema(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool as any,
      {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        tools: [],
        agents: [],
      },
    )
    return schema as { eager_input_streaming?: boolean }
  }

  beforeEach(async () => {
    const { clearToolSchemaCache } = await import(
      '../../../utils/toolSchemaCache.js'
    )
    clearToolSchemaCache()
  })

  test('bedrock + default endpoint (env unset) + fgts env flag → eager_input_streaming ON', async () => {
    // Arrange
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = '1'

    // Act
    const schema = await serializeProbeTool()

    // Assert — 308 behavior was OFF here only when the env var was SET to the
    // default endpoint; unset was already on via `!env`. Pin both.
    expect(schema.eager_input_streaming).toBe(true)
  })

  test('bedrock + ANTHROPIC_BEDROCK_BASE_URL = default endpoint + fgts env flag → ON (THE 309 FIX)', async () => {
    // Arrange — 308's `!a.ANTHROPIC_BEDROCK_BASE_URL` arm made this OFF
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = '1'
    process.env.ANTHROPIC_BEDROCK_BASE_URL =
      'https://bedrock-runtime.us-east-1.amazonaws.com'

    // Act
    const schema = await serializeProbeTool()

    // Assert
    expect(schema.eager_input_streaming).toBe(true)
  })

  test('bedrock + custom proxy endpoint + fgts env flag → OFF (400-avoidance preserved)', async () => {
    // Arrange
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = '1'
    process.env.ANTHROPIC_BEDROCK_BASE_URL = 'https://my-proxy.example.com'

    // Act
    const schema = await serializeProbeTool()

    // Assert
    expect(schema.eager_input_streaming).toBeUndefined()
  })

  test('bedrock + default endpoint but NO fgts flag/env → OFF (OCC gates behind tengu_fgts/env — declared deviation)', async () => {
    // Arrange
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    // Act
    const schema = await serializeProbeTool()

    // Assert
    expect(schema.eager_input_streaming).toBeUndefined()
  })

  test('firstParty + fgts env flag → ON (regression guard)', async () => {
    // Arrange
    process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = '1'

    // Act
    const schema = await serializeProbeTool()

    // Assert
    expect(schema.eager_input_streaming).toBe(true)
  })

  test('firstParty behind ANTHROPIC_BASE_URL proxy + fgts env flag → OFF (regression guard)', async () => {
    // Arrange
    process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = '1'
    process.env.ANTHROPIC_BASE_URL = 'https://my-gateway.example.com'

    // Act
    const schema = await serializeProbeTool()

    // Assert
    expect(schema.eager_input_streaming).toBeUndefined()
  })
})
