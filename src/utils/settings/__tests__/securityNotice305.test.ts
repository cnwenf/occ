import { describe, expect, test } from 'bun:test'
import { validatePermissionRule } from '../permissionValidation.js'

/**
 * CC 2.1.305 — validator `securityNotice` channel (research-R3 ITEM 2d).
 *
 * Byte-verified against the v306 binary (`rLe` @238393000). NOTE the gating
 * is MIXED in the official binary — the research doc claimed all notices are
 * deny/ask-only, but the binary shows:
 *   1. "allows any option at its *" (wildcard-before-subcommand) → ALLOW only
 *      (unconditional property inside the existing `behavior === 'allow'`
 *      warning gate).
 *   2. "reads its * literally" (mixes * with trailing :*) → NON-allow only
 *      (spread gate `...n!=="allow"&&{securityNotice:...}`).
 *   3. "reads its :* as a wildcard" (mid-pattern :*) → ALLOW only
 *      (spread gate `...n==="allow"&&{securityNotice:...}`).
 *   4. "never matches" (Write/Glob/NotebookEdit/MultiEdit file rules) →
 *      NON-allow only (spread gate `...n!=="allow"&&{securityNotice:...}`).
 * The binary wins; these tests pin the binary-exact gating.
 */

describe('CC 2.1.305 securityNotice — allows any option at its *', () => {
  test('allow Bash(git * main) gets the exact notice', () => {
    const result = validatePermissionRule('Bash(git * main)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeDefined()
    expect(result.securityNotice).toBe(
      'Bash(git * main) allows any option at its * · use an exact value',
    )
  })

  test('allow with a non-git command gets the same notice shape', () => {
    const result = validatePermissionRule('Bash(npm * install)', 'allow')
    expect(result.securityNotice).toBe(
      'Bash(npm * install) allows any option at its * · use an exact value',
    )
  })

  test('deny never gets the notice (allow-only gate)', () => {
    expect(validatePermissionRule('Bash(git * main)', 'deny').securityNotice).toBeUndefined()
  })

  test('ask never gets the notice (allow-only gate)', () => {
    expect(validatePermissionRule('Bash(git * main)', 'ask').securityNotice).toBeUndefined()
  })

  test('no behavior never gets the notice', () => {
    expect(validatePermissionRule('Bash(git * main)').securityNotice).toBeUndefined()
  })
})

describe('CC 2.1.305 securityNotice — reads its * literally', () => {
  test('deny Bash(npm * run:*) gets the notice with the use-part', () => {
    const result = validatePermissionRule('Bash(npm * run:*)', 'deny')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeDefined()
    expect(result.securityNotice).toBe(
      'Bash(npm * run:*) reads its * literally · use Bash(npm * run*)',
    )
  })

  test('ask gets the same notice (non-allow gate)', () => {
    expect(validatePermissionRule('Bash(npm * run:*)', 'ask').securityNotice).toBe(
      'Bash(npm * run:*) reads its * literally · use Bash(npm * run*)',
    )
  })

  test('suggested endsWith(":*") drops the use-part (byte-verified conditional)', () => {
    // content 'npm:*:*' → prefix 'npm:*' has an unescaped star AND ends with
    // an unescaped star → suggested = prefix = 'npm:*' which endsWith ':*'.
    const result = validatePermissionRule('Bash(npm:*:*)', 'deny')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeDefined()
    expect(result.securityNotice).toBe('Bash(npm:*:*) reads its * literally')
  })

  test('allow never gets the notice (non-allow gate)', () => {
    const result = validatePermissionRule('Bash(npm * run:*)', 'allow')
    expect(result.warning).toBeDefined()
    expect(result.securityNotice).toBeUndefined()
  })
})

describe('CC 2.1.305 securityNotice — reads its :* as a wildcard', () => {
  test('allow Bash(npm run:*build) gets the exact notice', () => {
    const result = validatePermissionRule('Bash(npm run:*build)', 'allow')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeDefined()
    expect(result.securityNotice).toBe(
      'Bash(npm run:*build) reads its :* as a wildcard · use an exact value',
    )
  })

  test('deny never gets the notice (allow-only gate)', () => {
    const result = validatePermissionRule('Bash(npm run:*build)', 'deny')
    expect(result.warning).toBeDefined()
    expect(result.securityNotice).toBeUndefined()
  })

  test('ask never gets the notice (allow-only gate)', () => {
    expect(validatePermissionRule('Bash(npm run:*build)', 'ask').securityNotice).toBeUndefined()
  })
})

describe('CC 2.1.305 securityNotice — never matches (file rules)', () => {
  test('deny Write(src/**) points at Edit(src/**)', () => {
    const result = validatePermissionRule('Write(src/**)', 'deny')
    expect(result.valid).toBe(true)
    expect(result.warning).toBeDefined()
    expect(result.securityNotice).toBe(
      'Write(src/**) never matches · use Edit(src/**)',
    )
  })

  test('ask Glob(src/**) points at Read(src/**)', () => {
    expect(validatePermissionRule('Glob(src/**)', 'ask').securityNotice).toBe(
      'Glob(src/**) never matches · use Read(src/**)',
    )
  })

  test('deny MultiEdit(src/**) points at Edit(src/**)', () => {
    expect(validatePermissionRule('MultiEdit(src/**)', 'deny').securityNotice).toBe(
      'MultiEdit(src/**) never matches · use Edit(src/**)',
    )
  })

  test('deny NotebookEdit(nb.ipynb) points at Edit(nb.ipynb)', () => {
    expect(validatePermissionRule('NotebookEdit(nb.ipynb)', 'deny').securityNotice).toBe(
      'NotebookEdit(nb.ipynb) never matches · use Edit(nb.ipynb)',
    )
  })

  test('allow never gets the notice (non-allow gate)', () => {
    const result = validatePermissionRule('Write(src/**)', 'allow')
    expect(result.warning).toBeDefined()
    expect(result.securityNotice).toBeUndefined()
  })

  test('canonical Edit/Read rules get no notice at all', () => {
    expect(validatePermissionRule('Edit(src/**)', 'deny').securityNotice).toBeUndefined()
    expect(validatePermissionRule('Read(src/**)', 'deny').securityNotice).toBeUndefined()
  })
})

describe('CC 2.1.305 securityNotice — no notice without a warning', () => {
  test('clean rules never carry a securityNotice', () => {
    expect(validatePermissionRule('Bash(npm run test)', 'allow').securityNotice).toBeUndefined()
    expect(validatePermissionRule('Bash(npm run test)', 'deny').securityNotice).toBeUndefined()
    expect(validatePermissionRule('Edit(src/**)', 'ask').securityNotice).toBeUndefined()
    expect(validatePermissionRule('WebFetch(domain:example.com)', 'deny').securityNotice).toBeUndefined()
  })

  test('invalid rules never carry a securityNotice', () => {
    expect(validatePermissionRule('Bash(:*)', 'allow').securityNotice).toBeUndefined()
    expect(validatePermissionRule('Read(*:*)', 'deny').securityNotice).toBeUndefined()
  })
})
