import { describe, expect, test } from 'bun:test'
import { substituteArguments } from '../../src/utils/argumentSubstitution.js'

describe('Skill \\$ escape (2.1.163, e2e)', () => {
  test('\\$ARGUMENTS stays literal (not expanded)', () => {
    expect(substituteArguments('cost: \\$ARGUMENTS', '5', false)).toBe(
      'cost: $ARGUMENTS',
    )
  })

  test('\\$5 stays literal (not expanded to arg index 5)', () => {
    expect(substituteArguments('price \\$5 today', 'a b c d e f', false)).toBe(
      'price $5 today',
    )
  })

  test('unescaped $ARGUMENTS still expands', () => {
    expect(substituteArguments('cost: $ARGUMENTS', '5', false)).toBe('cost: 5')
  })

  test('unescaped $0 still expands', () => {
    expect(substituteArguments('first: $0', 'a b', false)).toBe('first: a')
  })
})
