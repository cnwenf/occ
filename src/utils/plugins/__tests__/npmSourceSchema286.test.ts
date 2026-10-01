import { describe, expect, test } from 'bun:test'
import { PluginSourceSchema } from '../schemas.js'

/**
 * CC 2.1.286 npm-source schema alignment.
 *
 * The official npm `registry` field is
 *   `o().url().refine(fJe, "Registry must be an http(s) URL").optional()`
 * (v286 @197052120, byte-identical in v285 @196067580). OCC previously carried
 * `.url().optional()` WITHOUT the `fJe` refine — `.url()` alone also accepts
 * e.g. `ftp:`/`file:` registries. This test pins the added refine.
 *
 * The `package` field keeps `.or(z.string())` (official-faithful: the schema
 * stays permissive; git/folder/URL npm specs are refused at RUNTIME by
 * npmSpecValidation, not at parse time), and the `package`/`registry`
 * `.describe()` texts are byte-identical v285↔v286 (the spec's step-5
 * describe-tightening hypothesis was disproven against the binary).
 */
const npmSource = (over: Record<string, unknown>) =>
  PluginSourceSchema().safeParse({ source: 'npm', package: 'my-plugin', ...over })

describe('PluginSourceSchema npm registry refine (official fJe)', () => {
  test('accepts an https registry', () => {
    expect(npmSource({ registry: 'https://registry.npmjs.org' }).success).toBe(true)
  })
  test('accepts an http registry (Z8t gates http at runtime, not the schema)', () => {
    expect(npmSource({ registry: 'http://localhost:4873' }).success).toBe(true)
  })
  test('accepts no registry (optional)', () => {
    expect(npmSource({}).success).toBe(true)
  })
  test('rejects a non-http(s) registry that .url() alone would accept', () => {
    const r = npmSource({ registry: 'ftp://registry.example.com' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain('Registry must be an http(s) URL')
    }
  })
  test('rejects a garbage registry', () => {
    expect(npmSource({ registry: 'not a url' }).success).toBe(false)
  })
})

describe('PluginSourceSchema npm package field stays permissive (official .or(z.string()))', () => {
  test('accepts a plain registry name', () => {
    expect(npmSource({ package: 'my-plugin' }).success).toBe(true)
  })
  test('accepts a scoped registry name', () => {
    expect(npmSource({ package: '@scope/my-plugin' }).success).toBe(true)
  })
  test('accepts a URL string (runtime validation refuses git/folder specs)', () => {
    expect(npmSource({ package: 'https://example.com/a.tgz' }).success).toBe(true)
  })
})
