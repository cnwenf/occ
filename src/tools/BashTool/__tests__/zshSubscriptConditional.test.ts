import { describe, expect, test } from 'bun:test'
import { hasZshSubscriptInConditional } from '../bashPermissions'

/** M4 (CC 2.1.214): zsh variable subscripts and modifiers in [[ ]] comparisons
 * were treated as inert text → auto-allowed. Now prompt. Pure helper TDD. */

describe('M4 (2.1.214): zsh subscript in [[ ]] conditional', () => {
  test('[[ ${arr[0]} == x ]] → true (subscript)', () => {
    expect(hasZshSubscriptInConditional('[[ ${arr[0]} == x ]]')).toBe(true)
  })
  test('[[ ${#arr} -gt 0 ]] → true (# modifier)', () => {
    expect(hasZshSubscriptInConditional('[[ ${#arr} -gt 0 ]]')).toBe(true)
  })
  test('[[ ${var:0:3} == x ]] → true (substring modifier)', () => {
    expect(hasZshSubscriptInConditional('[[ ${var:0:3} == x ]]')).toBe(true)
  })
  test('[[ -f /path ]] → false (plain conditional)', () => {
    expect(hasZshSubscriptInConditional('[[ -f /path ]]')).toBe(false)
  })
  test('[[ $x == y ]] → false (simple var, no subscript)', () => {
    expect(hasZshSubscriptInConditional('[[ $x == y ]]')).toBe(false)
  })
  test('echo hello → false (no [[ ]])', () => {
    expect(hasZshSubscriptInConditional('echo hello')).toBe(false)
  })
  test('[[ ${arr[${idx}]} == x ]] → true (nested subscript)', () => {
    expect(hasZshSubscriptInConditional('[[ ${arr[${idx}]} == x ]]')).toBe(true)
  })
  test('if [[ ${arr[0]} ]]; then echo; fi → true (compound with [[ ]])', () => {
    expect(
      hasZshSubscriptInConditional('if [[ ${arr[0]} ]]; then echo; fi'),
    ).toBe(true)
  })
})
