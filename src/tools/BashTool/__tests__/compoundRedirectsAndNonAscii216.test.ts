import { describe, expect, test } from 'bun:test'
import {
  extractOutputRedirections,
  splitCommandWithOperators,
} from '../../../utils/bash/commands.js'
import { checkBashRedirectAndPatternSafety } from '../bashPermissions.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'

/**
 * CC 2.1.216 Stage 3 (#13 + #21) — regression coverage.
 *
 * Reverse-engineered per `aligning-with-official-binary`: the 2.1.216 changelog
 * describes two fixes —
 *   #13: "Fixed Bash command permission checking for compound statements with
 *         redirects inside && lists or negations."
 *   #21: "Fixed Bash command parsing of non-ASCII characters to match real
 *         shell word boundaries."
 *
 * Binary + behavioral recon found OCC's bash parser (the legacy regex/shell-quote
 * path — the production path in external builds, since `TREE_SITTER_BASH` is
 * not allowlisted) ALREADY produces 2.1.216-correct behavior for both. The
 * official's fixes were to its own minified parser's bugs, which OCC's
 * tree-sitter-bash-port-derived implementation does not share. Per the skill,
 * no code change is warranted — inventing a fix for a non-existent divergence
 * is forbidden. These tests lock the behavior in so it can't regress.
 */

const ctx = () => getEmptyToolPermissionContext()
const safety = (cmd: string) =>
  checkBashRedirectAndPatternSafety({ command: cmd } as never, ctx(), null, null)

// ─────────────────────────────────────────────────────────────────────────
// #13: redirects inside && / || / negation are permission-checked.
// ─────────────────────────────────────────────────────────────────────────
describe('CC 2.1.216 #13 — compound/negation redirect permission checking', () => {
  describe('extractOutputRedirections collects redirects from every compound arm', () => {
    test('redirect after && is collected', () => {
      const r = extractOutputRedirections('echo hi && cat f > out.txt')
      expect(r.redirections.some(x => x.target.endsWith('out.txt'))).toBe(true)
    })

    test('redirect after || is collected', () => {
      const r = extractOutputRedirections('false || cat f > out.txt')
      expect(r.redirections.some(x => x.target.endsWith('out.txt'))).toBe(true)
    })

    test('redirect after ! (negation) is collected', () => {
      const r = extractOutputRedirections('! cat f > out.txt')
      expect(r.redirections.some(x => x.target.endsWith('out.txt'))).toBe(true)
    })

    test('redirect on the SECOND arm of an && list is collected', () => {
      const r = extractOutputRedirections('cat f > a.txt && cat g > b.txt')
      const targets = r.redirections.map(x => x.target)
      expect(targets).toContain('a.txt')
      expect(targets).toContain('b.txt')
    })

    test('redirect after ; (sequential) is collected', () => {
      const r = extractOutputRedirections('echo hi; cat f > out.txt')
      expect(r.redirections.some(x => x.target.endsWith('out.txt'))).toBe(true)
    })
  })

  describe('checkBashRedirectAndPatternSafety flags compound/negation redirects', () => {
    // A build-tool config target (Makefile) triggers G8 in every compound form,
    // proving the redirect — even on a non-first arm / under negation — reaches
    // the permission check. (Startup-file ~-targets are a separate, flagged
    // observation — see the report; not #13.)
    test('Makefile redirect after && -> ask', () => {
      expect(safety('echo hi && cat f > Makefile').behavior).toBe('ask')
    })

    test('Makefile redirect after || -> ask', () => {
      expect(safety('false || cat f > Makefile').behavior).toBe('ask')
    })

    test('Makefile redirect after ! -> ask', () => {
      expect(safety('! cat f > Makefile').behavior).toBe('ask')
    })

    test('Makefile redirect after ; -> ask', () => {
      expect(safety('echo hi; cat f > Makefile').behavior).toBe('ask')
    })

    test('Makefile redirect on 2nd && arm -> ask', () => {
      expect(safety('cat f > a.txt && cat g > Makefile').behavior).toBe('ask')
    })

    test('non-sensitive redirect on 2nd && arm stays passthrough', () => {
      // Regression guard: don't over-trigger — a benign target is passthrough.
      expect(safety('cat f > a.txt && cat g > b.txt').behavior).toBe('passthrough')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// #21: non-ASCII characters match real shell word boundaries.
// ─────────────────────────────────────────────────────────────────────────
describe('CC 2.1.216 #21 — non-ASCII word boundaries match real shell', () => {
  describe('splitCommandWithOperators keeps non-ASCII within words', () => {
    test('Latin-1 supplement (é) stays in the word', () => {
      const segs = splitCommandWithOperators('echo héllo')
      expect(segs.join(' ')).toContain('héllo')
    })

    test('CJK stays in the word', () => {
      const segs = splitCommandWithOperators('echo 你好世界')
      expect(segs.join(' ')).toContain('你好世界')
    })

    test('em-dash (—) is NOT a shell metachar -> stays in the word', () => {
      const segs = splitCommandWithOperators('echo —flag')
      expect(segs.join(' ')).toContain('—flag')
    })

    test('en-dash (–) is NOT a shell metachar -> stays in the word', () => {
      const segs = splitCommandWithOperators('ls –l')
      expect(segs.join(' ')).toContain('–l')
    })

    test('non-ASCII inside a quoted arg is preserved', () => {
      const segs = splitCommandWithOperators('echo "café résumé"')
      expect(segs.join(' ')).toContain('café résumé')
    })
  })

  describe('redirects are still detected when non-ASCII is adjacent (no space)', () => {
    test('echo héllo>out.txt — non-ASCII word + redirect operator, no space', () => {
      const segs = splitCommandWithOperators('echo héllo>out.txt')
      // The redirect operator is recognized; héllo is NOT split.
      expect(segs.join(' ')).toContain('héllo')
      expect(segs.join(' ')).toContain('>')
      const red = extractOutputRedirections('echo héllo>out.txt').redirections
      expect(red.some(x => x.target.endsWith('out.txt'))).toBe(true)
    })

    test('non-ASCII command word + redirect in a compound arm', () => {
      const segs = splitCommandWithOperators('echo hi && café > out.txt')
      expect(segs.join(' ')).toContain('café')
      const red = extractOutputRedirections('echo hi && café > out.txt').redirections
      expect(red.some(x => x.target.endsWith('out.txt'))).toBe(true)
    })

    test('CJK command word + redirect', () => {
      const red = extractOutputRedirections('cat 日本語 > out.txt').redirections
      expect(red.some(x => x.target.endsWith('out.txt'))).toBe(true)
    })
  })
})
