/**
 * Official Claude Code 2.1.309 changelog item 42 — macOS git-missing DORMANT
 * parity. BIN309 module @240801080 (byte-verified, never executed):
 *   var Lvn="git is not installed on this Mac. To install it, run xcode-select --install, then try again.";
 *   function JNe(n,e){return!1}
 *   export{Lvn,JNe};
 * Spawn guard @240891566:
 *   if(T!==null&&JNe(A,T.env))return{stdout:"",stderr:Lvn,code:127,error:Lvn};
 *
 * The official linux-x64 predicate `JNe` is a FALSE STUB (@240801245) — there
 * is NO darwin detection logic in the recovered binary, so none is invented
 * here. These tests pin the verbatim message and the faithful false stub.
 */
import { describe, expect, test } from 'bun:test'
import {
  GIT_MISSING_MACOS_MESSAGE,
  isGitMissingOnMacos,
} from '../macosGitMissing.js'

describe('item 42 — macOS git-missing dormant parity', () => {
  test('message is byte-verbatim from BIN309 Lvn @240801142', () => {
    expect(GIT_MISSING_MACOS_MESSAGE).toBe(
      'git is not installed on this Mac. To install it, run xcode-select --install, then try again.',
    )
  })

  test('predicate is a faithful false stub (official linux-x64 JNe @240801245)', () => {
    // The recovered binary returns !1 unconditionally; the 127/Lvn guard path
    // therefore exists but is unreachable — exactly what OCC mirrors.
    expect(isGitMissingOnMacos('git', {})).toBe(false)
    expect(
      isGitMissingOnMacos('/usr/bin/git', { PATH: '/usr/bin' }),
    ).toBe(false)
    expect(isGitMissingOnMacos('', undefined)).toBe(false)
  })
})
