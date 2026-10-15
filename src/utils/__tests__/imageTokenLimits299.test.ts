import { afterAll, describe, expect, mock, test } from 'bun:test'

/**
 * Official 2.1.299 port (#069) — token-aware image display dimensions.
 *
 * Upstream evidence (linux-x64 2.1.299 ELF, byte-recovered):
 *   - Patch estimator (s299 @7008763):
 *       var St=28; function fgt(e,n){if(e<=0||n<=0)return 0;
 *         return Math.ceil(e/St)*Math.ceil(n/St)}
 *   - Binary-search scaler (s299 @23708400):
 *       var Ae=1568,ze=1568; function q(e,n,r=Ae,o=ze){
 *         if(e<=r&&n<=r&&fgt(e,n)<=o)return[e,n];
 *         if(n>e){let[m,h]=q(n,e,r,o);return[h,m]}
 *         let u=e/n,a=1,s=e;
 *         while(a+1<s){let m=a+s>>1,h=Math.max(Math.round(m/u),1);
 *           if(m<=r&&fgt(m,h)<=o)a=m;else s=m}
 *         return[a,Math.max(Math.round(a/u),1)]}
 *   - Wrapper Y (299 binary @222905316): maxWidth/maxHeight clamp FIRST,
 *     then `return r.maxImageTokens===void 0?[e,n]:q(e,n,1/0,r.maxImageTokens)`
 *   - Catalog `image_limits` (v299 @215970300+): exactly 11 entries carry
 *     {maxWidth:2576,maxHeight:2576,maxImageTokens:4784}; ALL other entries
 *     have NO image_limits key. `maxImageTokens:1568` has ZERO occurrences
 *     in the binary (1568 is only q's internal default `Ae=ze=1568`).
 *   - `maxImageTokens` has zero occurrences in the 296 binary (new in 299).
 *
 * Repo mock.module template (readTool281.test.ts): snapshot actuals BEFORE
 * mocking, dynamic-import the module under test AFTER registration, restore
 * in afterAll.
 */

const actualImageProcessor = {
  ...(await import('../../tools/FileReadTool/imageProcessor.js')),
}

let mockMetadata: { width?: number; height?: number; format?: string } = {
  width: 2500,
  height: 2400,
  format: 'png',
}
let mockOutputBuffer: Buffer = Buffer.alloc(100)
let lastResizeArgs: [number, number] | null = null

const makeFakeInstance = (): Record<string, unknown> => {
  const instance: Record<string, unknown> = {
    metadata: async () => mockMetadata,
    resize: (width: number, height: number) => {
      lastResizeArgs = [width, height]
      return instance
    },
    jpeg: () => instance,
    png: () => instance,
    webp: () => instance,
    toBuffer: async () => mockOutputBuffer,
  }
  return instance
}

mock.module('../../tools/FileReadTool/imageProcessor.js', () => ({
  ...actualImageProcessor,
  getImageProcessor: async () => (_input: Buffer) => makeFakeInstance(),
}))

const {
  estimateImageTokens,
  scaleForTokenBudget,
  applyImageLimits,
  maybeResizeAndDownsampleImageBuffer,
} = await import('../imageResizer.js')
const { getImageLimitsForModel, MODEL_IMAGE_LIMITS } = await import(
  '../model/configs.js'
)
const { DEFAULT_IMAGE_LIMITS } = await import('../../constants/apiLimits.js')

afterAll(() => {
  mock.module(
    '../../tools/FileReadTool/imageProcessor.js',
    () => actualImageProcessor,
  )
})

// Official catalog triple for newer models (v299 @215970820).
const TOKEN_AWARE_LIMITS = {
  maxWidth: 2576,
  maxHeight: 2576,
  maxImageTokens: 4784,
}

describe('estimateImageTokens (official fgt, St=28)', () => {
  test('zero or negative dimensions yield 0', () => {
    expect(estimateImageTokens(0, 100)).toBe(0)
    expect(estimateImageTokens(100, 0)).toBe(0)
    expect(estimateImageTokens(-5, -5)).toBe(0)
  })

  test('counts 28px patches with ceiling rounding', () => {
    expect(estimateImageTokens(28, 28)).toBe(1)
    expect(estimateImageTokens(29, 29)).toBe(4)
    expect(estimateImageTokens(56, 84)).toBe(6)
  })

  test('near-square 2500x2400 exceeds the 4784 budget (the #069 case)', () => {
    // ceil(2500/28)=90, ceil(2400/28)=86 → 7740 > 4784
    expect(estimateImageTokens(2500, 2400)).toBe(7740)
  })
})

describe('scaleForTokenBudget (official q, Ae=ze=1568 defaults)', () => {
  test('small images pass through unchanged', () => {
    expect(scaleForTokenBudget(100, 80)).toEqual([100, 80])
    expect(scaleForTokenBudget(1, 1)).toEqual([1, 1])
  })

  test('defaults clamp the long edge to 1568 with aspect preserved', () => {
    // u=20 → largest fit is exactly the 1568 cap; round(1568/20)=78
    expect(scaleForTokenBudget(2000, 100)).toEqual([1568, 78])
  })

  test('portrait input is handled via the official swap recursion', () => {
    expect(scaleForTokenBudget(100, 2000)).toEqual([78, 1568])
  })

  test('2500x2400 near-square under a 4784 token budget scales to [1960, 1882]', () => {
    // Deterministic binary-search result: ceil(1960/28)=70 patches wide,
    // ceil(1882/28)=68 high → 70*68=4760 ≤ 4784; every width in
    // 1961..2500 crosses the budget (71*68=4828 > 4784).
    const [width, height] = scaleForTokenBudget(
      2500,
      2400,
      Number.POSITIVE_INFINITY,
      4784,
    )
    expect([width, height]).toEqual([1960, 1882])
    expect(estimateImageTokens(width, height)).toBeLessThanOrEqual(4784)
  })

  test('aspect ratio is preserved within rounding', () => {
    const [width, height] = scaleForTokenBudget(
      2500,
      2400,
      Number.POSITIVE_INFINITY,
      4784,
    )
    const expectedAspect = 2500 / 2400
    expect(Math.abs(width / height - expectedAspect)).toBeLessThan(
      0.02 * expectedAspect,
    )
  })
})

describe('applyImageLimits (official Y)', () => {
  test('clamps against maxWidth/maxHeight when no maxImageTokens', () => {
    expect(applyImageLimits(2500, 2400, DEFAULT_IMAGE_LIMITS)).toEqual([
      2000, 1920,
    ])
    // Height-dominant clamp runs second, per the official ordering
    expect(applyImageLimits(2400, 2500, DEFAULT_IMAGE_LIMITS)).toEqual([
      1920, 2000,
    ])
  })

  test('images within limits and without token budget are unchanged', () => {
    expect(applyImageLimits(1000, 800, DEFAULT_IMAGE_LIMITS)).toEqual([
      1000, 800,
    ])
    expect(applyImageLimits(100, 80, TOKEN_AWARE_LIMITS)).toEqual([100, 80])
  })

  test('token budget applies AFTER the dimension clamp (wrapper order)', () => {
    const [width, height] = applyImageLimits(2500, 2400, TOKEN_AWARE_LIMITS)
    // No dimension clamp (both ≤ 2576), so the budget scaler decides:
    expect([width, height]).toEqual([1960, 1882])
    expect(estimateImageTokens(width, height)).toBeLessThanOrEqual(4784)
  })

  test('oversized image is clamped to 2576 then token-scaled', () => {
    const [width, height] = applyImageLimits(3000, 2000, TOKEN_AWARE_LIMITS)
    expect(width).toBeLessThanOrEqual(2576)
    expect(height).toBeLessThanOrEqual(2576)
    expect(estimateImageTokens(width, height)).toBeLessThanOrEqual(4784)
    // Aspect preserved within rounding (3000/2000 = 1.5)
    expect(Math.abs(width / height - 1.5)).toBeLessThan(0.03)
  })
})

describe('getImageLimitsForModel (official 299 image_limits catalog)', () => {
  const TOKEN_AWARE_MODELS = [
    'claude-haiku-5-5',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-fable-5',
    'claude-fable-5-1',
  ]

  test.each(TOKEN_AWARE_MODELS)(
    '%s gets the 2576/2576/4784 triple',
    modelId => {
      expect(getImageLimitsForModel(modelId)).toEqual(TOKEN_AWARE_LIMITS)
    },
  )

  test('older models have NO image_limits (official catalog: key absent)', () => {
    // The official binary has zero maxImageTokens:1568 occurrences — older
    // models resolve to the 2000×2000 defaults with no token budget.
    for (const modelId of [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-3-5-haiku-20241022',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-1-20250805',
    ]) {
      const limits = getImageLimitsForModel(modelId)
      expect(limits).toEqual(DEFAULT_IMAGE_LIMITS)
      expect(limits.maxImageTokens).toBeUndefined()
    }
  })

  test('provider-specific ids resolve through the catalog entry', () => {
    expect(getImageLimitsForModel('us.anthropic.claude-sonnet-5-5')).toEqual(
      TOKEN_AWARE_LIMITS,
    )
    expect(getImageLimitsForModel('anthropic.claude-opus-5')).toEqual(
      TOKEN_AWARE_LIMITS,
    )
    // bedrock older-model id still defaults
    expect(
      getImageLimitsForModel('us.anthropic.claude-opus-4-6-v1'),
    ).toEqual(DEFAULT_IMAGE_LIMITS)
  })

  test('unknown or missing ids default (wrapper no-ops token scaling)', () => {
    expect(getImageLimitsForModel()).toEqual(DEFAULT_IMAGE_LIMITS)
    expect(getImageLimitsForModel('gpt-4o')).toEqual(DEFAULT_IMAGE_LIMITS)
  })

  test('catalog data matches the official 9 OCC-present 4784 entries', () => {
    expect(Object.keys(MODEL_IMAGE_LIMITS).sort()).toEqual(
      [...TOKEN_AWARE_MODELS].sort(),
    )
  })
})

describe('maybeResizeAndDownsampleImageBuffer (integration, mocked sharp)', () => {
  test('near-square large image on a token-aware model: display dims fit the budget', async () => {
    mockMetadata = { width: 2500, height: 2400, format: 'png' }
    mockOutputBuffer = Buffer.alloc(100)
    lastResizeArgs = null

    const buffer = Buffer.alloc(1000)
    const result = await maybeResizeAndDownsampleImageBuffer(
      buffer,
      4_000_000, // over the 3.75MB raw target → forces the resize path
      'png',
      TOKEN_AWARE_LIMITS,
    )

    expect(result.dimensions).toEqual({
      originalWidth: 2500,
      originalHeight: 2400,
      displayWidth: 1960,
      displayHeight: 1882,
    })
    expect(
      estimateImageTokens(
        result.dimensions?.displayWidth ?? 0,
        result.dimensions?.displayHeight ?? 0,
      ),
    ).toBeLessThanOrEqual(4784)
    // The physical resize targets the same display dims (official: resize to y×P)
    expect(lastResizeArgs).toEqual([1960, 1882])
  })

  test('model WITHOUT maxImageTokens: 2000×2000 clamp only (296-behavior regression)', async () => {
    mockMetadata = { width: 2500, height: 2400, format: 'png' }
    mockOutputBuffer = Buffer.alloc(100)
    lastResizeArgs = null

    const result = await maybeResizeAndDownsampleImageBuffer(
      Buffer.alloc(1000),
      1000, // under the raw target — only dimensions force work
      'png',
      DEFAULT_IMAGE_LIMITS,
    )

    expect(result.dimensions).toEqual({
      originalWidth: 2500,
      originalHeight: 2400,
      displayWidth: 2000,
      displayHeight: 1920,
    })
    expect(lastResizeArgs).toEqual([2000, 1920])
  })

  test('small image within limits: buffer passes through, display dims = original', async () => {
    mockMetadata = { width: 100, height: 80, format: 'png' }
    lastResizeArgs = null

    const buffer = Buffer.alloc(50)
    const result = await maybeResizeAndDownsampleImageBuffer(
      buffer,
      50,
      'png',
      TOKEN_AWARE_LIMITS,
    )

    expect(result.buffer).toBe(buffer)
    expect(result.dimensions).toEqual({
      originalWidth: 100,
      originalHeight: 80,
      displayWidth: 100,
      displayHeight: 80,
    })
    expect(lastResizeArgs).toBeNull()
  })

  test('no explicit limits: resolves via current model without throwing', async () => {
    mockMetadata = { width: 100, height: 80, format: 'png' }
    mockOutputBuffer = Buffer.alloc(100)
    lastResizeArgs = null

    // Exercises getCurrentImageLimits() (lazy model import). Whatever the
    // test environment resolves to, a small image must come back with
    // display dims equal to the originals.
    const result = await maybeResizeAndDownsampleImageBuffer(
      Buffer.alloc(50),
      50,
      'png',
    )
    expect(result.dimensions?.displayWidth).toBe(100)
    expect(result.dimensions?.displayHeight).toBe(80)
  })
})
