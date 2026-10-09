import { describe, expect, test } from 'bun:test'
import { FileReadTool } from '../FileReadTool.js'

/**
 * CC 2.1.292 §C5 (docs/gap-research-293/cluster-c-h-carryover.md): the
 * official Read tool wires `coerceInput:_7n` @214910806 — DIRECT, no pH
 * gate, no flag, no resultNote (silent coercion, shapeClass telemetry only).
 * Verbatim official coercer (@214910800):
 *
 *   function z6e(e){if(typeof e==="number")return Number.isFinite(e)?e:void 0;
 *     if(typeof e==="string"&&/^[-+]?\d+$/.test(e.trim()))return Number(e);return}
 *   function _7n(e){if(!L(e))return null;let n={...e},r=[];
 *     if(Array.isArray(n.offset)&&n.offset.length===1)n.offset=n.offset[0],r.push("offset_array");
 *     if(Array.isArray(n.limit)&&n.limit.length===1)n.limit=n.limit[0],r.push("limit_array");
 *     let s=z6e(n.offset);if(s!==void 0&&s<0)delete n.offset,r.push("offset_neg");
 *     let g=z6e(n.limit);if(g!==void 0&&g<=0)delete n.limit,r.push("limit_dropped");
 *     if("length"in n){let h=z6e(n.length);if(!("limit"in n)&&h!==void 0&&h>0)n.limit=h;
 *       delete n.length,r.push("length")}
 *     if(Object.hasOwn(n,"description"))delete n.description,r.push("drop_description");
 *     return r.length?{input:n,shapeClass:r.join(",")}:null}
 *
 * Note `_7n` only READS offset/limit through z6e (sign checks) — raw values
 * are preserved (string offsets are coerced later by the schema's
 * semanticNumber); only `length` migration writes a z6e number into `limit`.
 */

type Repair = { input: Record<string, unknown>; shapeClass: string; resultNote?: string }

function coerce(raw: unknown): Repair | null {
  const fn = (FileReadTool as { coerceInput?: (input: unknown) => Repair | null })
    .coerceInput
  if (typeof fn !== 'function') {
    throw new Error('FileReadTool.coerceInput is not wired (official: coerceInput:_7n)')
  }
  return fn.call(FileReadTool, raw)
}

describe('FileReadTool coerceInput (_7n port, CC 2.1.292 §C5)', () => {
  test('single-element offset array is unwrapped (offset_array)', () => {
    const repair = coerce({ file_path: '/a.txt', offset: ['5'] })
    expect(repair).not.toBeNull()
    expect(repair!.shapeClass).toBe('offset_array')
    expect(repair!.input.offset).toBe('5')
    // The unwrapped input parses under the strict schema (semanticNumber
    // coerces the numeric string at parse time).
    expect(FileReadTool.inputSchema.safeParse(repair!.input).success).toBe(true)
  })

  test('single-element limit array is unwrapped (limit_array)', () => {
    const repair = coerce({ file_path: '/a.txt', limit: [10] })
    expect(repair).not.toBeNull()
    expect(repair!.shapeClass).toBe('limit_array')
    expect(repair!.input.limit).toBe(10)
  })

  test('negative offset is dropped (offset_neg), including numeric-string form', () => {
    const repair = coerce({ file_path: '/a.txt', offset: -1 })
    expect(repair!.shapeClass).toBe('offset_neg')
    expect('offset' in repair!.input).toBe(false)

    const stringForm = coerce({ file_path: '/a.txt', offset: '-3' })
    expect(stringForm!.shapeClass).toBe('offset_neg')
    expect('offset' in stringForm!.input).toBe(false)
  })

  test('non-positive limit is dropped (limit_dropped)', () => {
    const zero = coerce({ file_path: '/a.txt', limit: 0 })
    expect(zero!.shapeClass).toBe('limit_dropped')
    expect('limit' in zero!.input).toBe(false)

    const negative = coerce({ file_path: '/a.txt', limit: '-5' })
    expect(negative!.shapeClass).toBe('limit_dropped')
    expect('limit' in negative!.input).toBe(false)
  })

  test('legacy `length` migrates to limit (length), numeric strings via z6e', () => {
    const repair = coerce({ file_path: '/a.txt', length: '10' })
    expect(repair!.shapeClass).toBe('length')
    expect(repair!.input.limit).toBe(10)
    expect('length' in repair!.input).toBe(false)
    expect(FileReadTool.inputSchema.safeParse(repair!.input).success).toBe(true)
  })

  test('`length` is deleted but does NOT override an explicit limit', () => {
    const repair = coerce({ file_path: '/a.txt', length: 10, limit: 5 })
    expect(repair!.shapeClass).toBe('length')
    expect(repair!.input.limit).toBe(5)
    expect('length' in repair!.input).toBe(false)
  })

  test('`length` is deleted even when non-migratable (non-positive / non-numeric)', () => {
    const zeroLength = coerce({ file_path: '/a.txt', length: 0 })
    expect(zeroLength!.shapeClass).toBe('length')
    expect('length' in zeroLength!.input).toBe(false)
    expect('limit' in zeroLength!.input).toBe(false)

    const junkLength = coerce({ file_path: '/a.txt', length: 'abc' })
    expect(junkLength!.shapeClass).toBe('length')
    expect('limit' in junkLength!.input).toBe(false)
  })

  test('stray `description` parameter is dropped (drop_description) — official 2.1.292 Read', () => {
    const repair = coerce({ file_path: '/a.txt', description: 'read the file' })
    expect(repair!.shapeClass).toBe('drop_description')
    expect('description' in repair!.input).toBe(false)
    expect(FileReadTool.inputSchema.safeParse(repair!.input).success).toBe(true)
  })

  test('multiple repairs accumulate tags in official order (comma-joined)', () => {
    const repair = coerce({
      file_path: '/a.txt',
      offset: [-2],
      description: 'x',
    })
    // Order per _7n: offset_array → offset_neg → drop_description
    expect(repair!.shapeClass).toBe('offset_array,offset_neg,drop_description')
    expect('offset' in repair!.input).toBe(false)
    expect('description' in repair!.input).toBe(false)
  })

  test('returns null for a clean input (no coercion needed)', () => {
    expect(coerce({ file_path: '/a.txt' })).toBeNull()
    expect(coerce({ file_path: '/a.txt', offset: 1, limit: 10 })).toBeNull()
  })

  test('returns null for non-record inputs', () => {
    expect(coerce(null)).toBeNull()
    expect(coerce(undefined)).toBeNull()
    expect(coerce('file.txt')).toBeNull()
    expect(coerce(42)).toBeNull()
    expect(coerce([{ file_path: '/a.txt' }])).toBeNull()
  })

  test('no resultNote — official Read wiring is silent (unlike Write/Grep)', () => {
    const repair = coerce({ file_path: '/a.txt', description: 'x' })
    expect(repair).not.toBeNull()
    expect('resultNote' in repair!).toBe(false)
  })

  test('does not mutate the original input (immutable repair)', () => {
    const original = { file_path: '/a.txt', description: 'x', offset: -1 }
    const snapshot = { ...original }
    coerce(original)
    expect(original).toEqual(snapshot)
  })
})
