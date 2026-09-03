import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Gap-114b tests — OCC version catch-up 2.1.258 → 2.1.259
 * (issue OCC-114, round 2026-09-04).
 *
 * Gap-114b: glab MR recognition (official 2.1.259 changelog entry 003):
 *   "Added recognition of `glab mr create/merge/close/reopen/note/update` so
 *   GitLab merge requests show as `MR !N` in the collapsed tool summary and
 *   refresh the footer MR badge."
 *
 * Ported surfaces (all byte-verified against the official 2.1.259 linux-x64
 * binary; offsets in docs/upstream-version-gap-occ114.md):
 *   - GLAB_MR_ACTIONS verb table — binary `Aat` (6 verbs: create/update/
 *     merge/note/close/reopen → created/edited/merged/commented/closed/
 *     reopened, ops pr_create/pr_edit/pr_merge/pr_comment/pr_close/
 *     pr_reopen).
 *   - resolvePrAction — binary `Rat`: gh table wins; `gh pr merge
 *     --disable-auto` → auto-merge-disabled, `--auto` → auto-merge-enabled;
 *     `gh pr ready --undo` → draft; glab `update --ready` → ready,
 *     `--draft` → draft; flag checks run on quoted-string-blanked command
 *     (binary `Iue`).
 *   - gh pr reopen added to the gh table — fixes pre-2.1.259 drift
 *     (pr_reopen verified present in the 2.1.258 binary too).
 *   - PR_URL_RE — binary `wgt`: GitHub `pull`, Bitbucket `pull-requests`,
 *     GitLab `-/merge_requests` families.
 *   - findPrInStdout — binary `Pat`: LAST URL in stdout wins.
 *   - isMrUrl — binary `e6`; PR_BADGE_URL_MAX_LENGTH — binary `wje` = 2048.
 *   - detectGitOperation pr branch: resolver + URL, text-number fallback is
 *     gh-only (binary: `else if(FLe.some(...))`).
 *
 * Renderer verb map + MR badge wiring lives in
 * src/components/messages/CollapsedReadSearchContent.tsx (asserted at source
 * level below — its render path needs the full Ink tree).
 */

import {
  PR_BADGE_URL_MAX_LENGTH,
  detectGitOperation,
  isMrUrl,
  resolvePrAction,
  trackGitOperations,
} from '../../src/tools/shared/gitOperationTracking.js'

describe('Gap-114b: resolvePrAction — gh verb table (binary FLe + Rat)', () => {
  test('resolves every gh pr verb to its action', () => {
    // Arrange / Act / Assert — one row per binary FLe entry
    expect(resolvePrAction('gh pr create --title "x"')).toBe('created')
    expect(resolvePrAction('gh pr edit 5 --add-label bug')).toBe('edited')
    expect(resolvePrAction('gh pr merge 5')).toBe('merged')
    expect(resolvePrAction('gh pr comment 5 --body hi')).toBe('commented')
    expect(resolvePrAction('gh pr close 5')).toBe('closed')
    expect(resolvePrAction('gh pr reopen 5')).toBe('reopened')
    expect(resolvePrAction('gh pr ready 5')).toBe('ready')
  })

  test('returns undefined for non-PR commands', () => {
    // Arrange / Act / Assert
    expect(resolvePrAction('git commit -m "x"')).toBeUndefined()
    expect(resolvePrAction('git push origin main')).toBeUndefined()
    expect(resolvePrAction('gh pr view 5')).toBeUndefined()
    expect(resolvePrAction('gh issue create')).toBeUndefined()
    expect(resolvePrAction('echo glab mr create')).toBe('created') // regex is on raw text, same as binary
  })

  test('gh pr merge --auto resolves to auto-merge-enabled', () => {
    // Arrange / Act / Assert — binary Rat merged-branch, checked on unquoted
    expect(resolvePrAction('gh pr merge 5 --auto')).toBe('auto-merge-enabled')
    expect(resolvePrAction('gh pr merge 5 --auto --squash')).toBe(
      'auto-merge-enabled',
    )
  })

  test('gh pr merge --disable-auto wins over --auto', () => {
    // Arrange / Act / Assert — binary checks --disable-auto first
    expect(resolvePrAction('gh pr merge 5 --disable-auto')).toBe(
      'auto-merge-disabled',
    )
    expect(resolvePrAction('gh pr merge 5 --auto --disable-auto')).toBe(
      'auto-merge-disabled',
    )
  })

  test('gh pr ready --undo resolves to draft', () => {
    // Arrange / Act / Assert
    expect(resolvePrAction('gh pr ready 5 --undo')).toBe('draft')
  })

  test('flag checks ignore flag-shaped text inside quotes (binary Iue)', () => {
    // Arrange — a commit-message-style quoted arg containing --auto
    // Act / Assert — the quoted span is blanked before the flag test
    expect(resolvePrAction('gh pr merge 5 "--auto"')).toBe('merged')
    expect(resolvePrAction("gh pr merge 5 'fix: --disable-auto note'")).toBe(
      'merged',
    )
    expect(
      resolvePrAction('gh pr merge 5 --auto "body mentioning --disable-auto"'),
    ).toBe('auto-merge-enabled')
  })
})

describe('Gap-114b: resolvePrAction — glab verb table (binary Aat + Rat)', () => {
  test('resolves every glab mr verb to its action', () => {
    // Arrange / Act / Assert — one row per binary Aat entry
    expect(resolvePrAction('glab mr create --title "x"')).toBe('created')
    expect(resolvePrAction('glab mr update 7 --title y')).toBe('edited')
    expect(resolvePrAction('glab mr merge 7')).toBe('merged')
    expect(resolvePrAction('glab mr note 7 -m "thanks"')).toBe('commented')
    expect(resolvePrAction('glab mr close 7')).toBe('closed')
    expect(resolvePrAction('glab mr reopen 7')).toBe('reopened')
  })

  test('glab mr update --ready/--draft refine to ready/draft', () => {
    // Arrange / Act / Assert — binary Rat glab branch
    expect(resolvePrAction('glab mr update 7 --ready')).toBe('ready')
    expect(resolvePrAction('glab mr update 7 --draft')).toBe('draft')
    // --ready is checked before --draft in the binary
    expect(resolvePrAction('glab mr update 7 --draft --ready')).toBe('ready')
  })

  test('glab mr merge has no auto-merge semantics (gh-only refinement)', () => {
    // Arrange / Act / Assert — binary applies --auto checks only to the gh
    // merged action; glab merge with --when-pipeline-succeeds stays 'merged'
    expect(resolvePrAction('glab mr merge 7 --when-pipeline-succeeds')).toBe(
      'merged',
    )
  })

  test('gh table wins when both gh and glab verbs appear (binary Rat order)', () => {
    // Arrange / Act / Assert — binary: gh action resolved first, then
    // `if(n)return n` before the glab lookup
    expect(resolvePrAction('gh pr create && glab mr close 7')).toBe('created')
  })
})

describe('Gap-114b: isMrUrl and badge cap (binary e6 / wje)', () => {
  test('isMrUrl detects GitLab MR URLs only', () => {
    // Arrange / Act / Assert
    expect(
      isMrUrl('https://gitlab.com/group/proj/-/merge_requests/7'),
    ).toBe(true)
    expect(
      isMrUrl('https://gitlab.example.co.uk/a/b/c/-/merge_requests/123'),
    ).toBe(true)
    expect(isMrUrl('https://github.com/owner/repo/pull/42')).toBe(false)
    expect(
      isMrUrl('https://bitbucket.org/team/repo/pull-requests/9'),
    ).toBe(false)
  })

  test('PR_BADGE_URL_MAX_LENGTH is 2048 (binary wje)', () => {
    // Arrange / Act / Assert
    expect(PR_BADGE_URL_MAX_LENGTH).toBe(2048)
  })
})

describe('Gap-114b: detectGitOperation — MR URL extraction (binary Pat)', () => {
  test('glab mr create with an MR URL in stdout surfaces the MR', () => {
    // Arrange
    const url = 'https://gitlab.com/group/proj/-/merge_requests/7'
    // Act
    const result = detectGitOperation(
      'glab mr create --title "Add feature"',
      `Creating merge request...\n${url}\n`,
    )
    // Assert
    expect(result.pr).toEqual({ number: 7, url, action: 'created' })
  })

  test('glab mr note/merge/close/reopen carry their resolved actions', () => {
    // Arrange
    const url = 'https://gitlab.com/group/proj/-/merge_requests/12'
    // Act / Assert
    expect(
      detectGitOperation('glab mr note 12 -m "lgtm"', url).pr,
    ).toEqual({ number: 12, url, action: 'commented' })
    expect(detectGitOperation('glab mr merge 12', url).pr).toEqual({
      number: 12,
      url,
      action: 'merged',
    })
    expect(detectGitOperation('glab mr close 12', url).pr).toEqual({
      number: 12,
      url,
      action: 'closed',
    })
    expect(detectGitOperation('glab mr reopen 12', url).pr).toEqual({
      number: 12,
      url,
      action: 'reopened',
    })
  })

  test('glab mr update --ready surfaces the ready action', () => {
    // Arrange
    const url = 'https://gitlab.com/group/proj/-/merge_requests/3'
    // Act
    const result = detectGitOperation('glab mr update 3 --ready', url)
    // Assert
    expect(result.pr).toEqual({ number: 3, url, action: 'ready' })
  })

  test('LAST PR/MR URL in stdout wins (binary Pat semantics)', () => {
    // Arrange — earlier URL from view noise, new URL printed at the end
    const oldUrl = 'https://github.com/owner/repo/pull/1'
    const newUrl = 'https://gitlab.com/group/proj/-/merge_requests/42'
    // Act
    const result = detectGitOperation(
      'glab mr create --title "x"',
      `see ${oldUrl} for context\nCreated: ${newUrl}\n`,
    )
    // Assert
    expect(result.pr).toEqual({ number: 42, url: newUrl, action: 'created' })
  })

  test('parses GitHub and Bitbucket PR URLs too (binary wgt family)', () => {
    // Arrange / Act / Assert
    expect(
      detectGitOperation(
        'gh pr create',
        'https://github.com/owner/repo/pull/42',
      ).pr,
    ).toEqual({
      number: 42,
      url: 'https://github.com/owner/repo/pull/42',
      action: 'created',
    })
    expect(
      detectGitOperation(
        'glab mr create',
        'https://bitbucket.org/team/repo/pull-requests/9',
      ).pr,
    ).toEqual({
      number: 9,
      url: 'https://bitbucket.org/team/repo/pull-requests/9',
      action: 'created',
    })
  })

  test('nested GitLab group paths are captured in the URL (repository span)', () => {
    // Arrange — group/sub/project must all stay inside the URL match
    const url = 'https://gitlab.com/group/sub/proj/-/merge_requests/5'
    // Act
    const result = detectGitOperation('glab mr merge 5', url)
    // Assert
    expect(result.pr).toEqual({ number: 5, url, action: 'merged' })
  })

  test('glab command without a URL yields no pr entry (no text fallback)', () => {
    // Arrange — glab prints "!N" text, but the binary's text-number fallback
    // is gh-only (`else if(FLe.some(...))`)
    // Act
    const result = detectGitOperation(
      'glab mr merge 7',
      'Merging merge request !7... done',
    )
    // Assert
    expect(result.pr).toBeUndefined()
  })

  test('gh command still falls back to text number parsing', () => {
    // Arrange / Act
    const result = detectGitOperation(
      'gh pr merge 1234',
      '✓ Merged pull request owner/repo#1234',
    )
    // Assert
    expect(result.pr).toEqual({ number: 1234, action: 'merged' })
  })

  test('gh pr reopen resolves through detection (pre-2.1.259 drift fix)', () => {
    // Arrange / Act
    const result = detectGitOperation(
      'gh pr reopen 8',
      '✓ Reopened pull request owner/repo#8',
    )
    // Assert
    expect(result.pr).toEqual({ number: 8, action: 'reopened' })
  })

  test('commit detection is unaffected by the pr-branch rework', () => {
    // Arrange / Act
    const result = detectGitOperation(
      'git commit -m "fix: thing"',
      '[main abc1234] fix: thing\n 1 file changed',
    )
    // Assert
    expect(result.commit).toEqual({ sha: 'abc123', kind: 'committed' })
    expect(result.pr).toBeUndefined()
  })
})

describe('Gap-114b: trackGitOperations — unified gh/glab telemetry flow', () => {
  test('glab mr create succeeds without stdout (telemetry path, no link)', () => {
    // Arrange / Act — the unified `ghHit ?? glabHit` flow must not throw for
    // glab verbs; no stdout → no session-link attempt
    // Assert — no exception is the contract (logEvent is a no-op stub)
    expect(() => trackGitOperations('glab mr create --title "x"', 0)).not.toThrow()
  })

  test('failed commands are ignored', () => {
    // Arrange / Act / Assert — non-zero exit returns early
    expect(() => trackGitOperations('glab mr merge 7', 1)).not.toThrow()
  })
})

describe('Gap-114b: renderer wiring (source-level, CollapsedReadSearchContent)', () => {
  const repoRoot = join(import.meta.dir, '..', '..')
  const rendererPath = join(
    repoRoot,
    'src',
    'components',
    'messages',
    'CollapsedReadSearchContent.tsx',
  )

  test('renderer imports MR helpers from gitOperationTracking', () => {
    // Arrange / Act
    const src = readFileSync(rendererPath, 'utf8')
    // Assert
    expect(existsSync(rendererPath)).toBe(true)
    expect(src.includes('PR_BADGE_URL_MAX_LENGTH')).toBe(true)
    expect(src.includes('isMrUrl')).toBe(true)
  })

  test('renderer verb map covers all 10 PrAction verbs (binary Re)', () => {
    // Arrange / Act
    const src = readFileSync(rendererPath, 'utf8')
    // Assert — one assertion per binary Re map entry
    for (const verb of [
      "created: 'created'",
      "edited: 'edited'",
      "merged: 'merged'",
      "commented: 'commented on'",
      "closed: 'closed'",
      "reopened: 'reopened'",
      "ready: 'marked ready'",
      "draft: 'marked draft'",
      "'auto-merge-enabled': 'enabled auto-merge on'",
      "'auto-merge-disabled': 'disabled auto-merge on'",
    ]) {
      expect(src.includes(verb)).toBe(true)
    }
  })

  test('renderer renders MR ! prefix for merge requests', () => {
    // Arrange / Act
    const src = readFileSync(rendererPath, 'utf8')
    // Assert — binary: `"MR !":"PR #"` text fallback + kind:'mr' badge
    expect(src.includes("kind={isMr ? 'mr' : undefined}")).toBe(true)
    expect(src.includes("'MR !'")).toBe(true)
  })
})

describe('Gap-114b: source-level drift guards (gitOperationTracking.ts)', () => {
  const repoRoot = join(import.meta.dir, '..', '..')
  const src = readFileSync(
    join(repoRoot, 'src', 'tools', 'shared', 'gitOperationTracking.ts'),
    'utf8',
  )

  test('glab table has exactly the 6 binary Aat verbs', () => {
    // Arrange / Act / Assert
    for (const verb of [
      'glab\\s+mr\\s+create',
      'glab\\s+mr\\s+update',
      'glab\\s+mr\\s+merge',
      'glab\\s+mr\\s+note',
      'glab\\s+mr\\s+close',
      'glab\\s+mr\\s+reopen',
    ]) {
      expect(src.includes(verb)).toBe(true)
    }
  })

  test('gh table includes reopen (pre-2.1.259 drift fix)', () => {
    // Arrange / Act / Assert
    expect(src.includes('gh\\s+pr\\s+reopen')).toBe(true)
  })

  test('telemetry uses the unified ghHit ?? glabHit flow', () => {
    // Arrange / Act / Assert — binary: `F=v??x`
    expect(src.includes('const prHit = ghHit ?? glabHit')).toBe(true)
    expect(src.includes('ghHit?.action === \'created\' || glabHit?.action === \'created\'')).toBe(true)
  })
})
