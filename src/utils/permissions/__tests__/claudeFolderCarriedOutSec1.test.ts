/**
 * OCC-134 acceptance-review SEC-1 (P3) — step 1.6 `.claude/**` session-allow
 * bypass must NOT grant an early-return allow when the write is CARRIED OUT
 * (physical landing resolves OUTSIDE the allowed working directories), even if
 * every spelling happens to match a .claude-scoped session rule.
 *
 * filesystem.ts step 1.6 (binary-ordered between the 1.55 unresolved deny and
 * the 1.7 safety checks) lets a session-scoped `/.claude/**` (or `~/.claude/**`)
 * grant skip the dangerous-path safety block and RETURN EARLY — before the
 * write-carried-out merge (`computeWriteCarriedOut`, CC 2.1.280 r2e). The M2
 * all-spellings landing check (claudeFolderAllowLanding280.test.ts) judges rule
 * SCOPE only: it passes when every spelling matches a scoped rule. That leaves a
 * divergence — a broad GLOBAL `~/.claude/**` grant makes an out-of-worktree
 * landing match a scoped rule while still escaping the worktree:
 *
 *   <wd>/.claude/gnotes  ->  ~/.claude/real-notes   (intermediate symlinked DIR)
 *   write <wd>/.claude/gnotes/newfile.md
 *     requested spelling  <wd>/.claude/gnotes/newfile.md      matches /.claude/**
 *     landing  spelling   ~/.claude/real-notes/newfile.md     matches ~/.claude/**
 *   => M2 `.every()` passes, but the landing is OUTSIDE the working dir
 *      (originalCwd + additionalWorkingDirectories = {<wd>}), so carriedOut=true.
 *
 * Pre-fix this returned `allow` (step-1.6 early return). The SEC-1 gate hangs
 * the bypass under `!carriedOut?.carriedOut`, so the carry-out ask (step 1.7
 * safety merge) wins — exactly the carry-out semantics a plain outside-worktree
 * write already produces. This is OCC hardening beyond official 2.1.280
 * (byte-faithful official returns the allow here), mirroring the M2
 * landing-check hardening and the --plugin-url HTTPS-only precedent.
 *
 * Farm layout (all under realpath'd tmpdir `farmReal`); `fakeHome` is wired as
 * the process homedir via mock.module('os') so the GLOBAL `~/.claude/**` rule
 * roots there and stays outside the proj working dir:
 *   proj/                                 (working dir + originalCwd)
 *     .claude/plain.md                    (benign real file — fast path)
 *     .claude/gnotes -> home/.claude/real-notes   (intermediate symlinked DIR
 *                                                  escaping the worktree)
 *   home/                                 (mocked homedir, NOT a working dir)
 *     .claude/real-notes/                 (real dir outside the worktree)
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Build the farm and install the homedir mock BEFORE importing filesystem.ts so
// its lazily-called `homedir()` (patternWithRoot / expandPath) resolves the
// global `~/.claude/**` rule root to `fakeHome`. Bun's os.homedir() is cached
// and ignores runtime HOME edits, so mock.module('os') is the only reliable
// redirect; mock.restore() in afterAll keeps it from leaking across files.
const farm = mkdtempSync(join(tmpdir(), 'occ-claude-carriedout-sec1-'))
const farmReal = realpathSync(farm)
const proj = join(farmReal, 'proj')
const fakeHome = join(farmReal, 'home')
mkdirSync(join(proj, '.claude'), { recursive: true })
mkdirSync(join(fakeHome, '.claude', 'real-notes'), { recursive: true })
writeFileSync(join(proj, '.claude', 'plain.md'), 'ok')
// Intermediate-layer symlinked DIRECTORY escaping the worktree, landing under
// the (mocked) home .claude so it matches a GLOBAL ~/.claude/** scoped rule.
symlinkSync(
  join(fakeHome, '.claude', 'real-notes'),
  join(proj, '.claude', 'gnotes'),
)

mock.module('os', () => {
  const actual = require('node:os')
  return { ...actual, default: { ...actual }, homedir: () => fakeHome }
})

import type { ToolPermissionContext } from '../../../Tool'
import { getOriginalCwd, setOriginalCwd } from '../../../bootstrap/state'
import {
  _clearMatcherCacheForTesting,
  checkWritePermissionForTool,
} from '../filesystem'
import {
  _clearPhysicalTwinsForTesting,
  _clearSymlinkEquivalencesForTesting,
} from '../symlinkEquivalences'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// The production dialog (usePermissionHandler.ts) adds `{toolName:'Edit',
// ruleContent:'/.claude/**'}` (and its `~/.claude/**` global variant) as SESSION
// rules, serialized into the context as `Edit(/.claude/**)` / `Edit(~/.claude/**)`.
// rootPathForSource('session') = expandPath(getOriginalCwd()), so originalCwd is
// pinned to proj; the global rule roots at the mocked homedir (fakeHome).
const PROJECT_CLAUDE_RULE = 'Edit(/.claude/**)'
const GLOBAL_CLAUDE_RULE = 'Edit(~/.claude/**)'

function makeContext(opts: {
  session?: string[]
  workdir: string
}): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map([
      [opts.workdir, { path: opts.workdir, source: 'userSettings' as const }],
    ]),
    alwaysAllowRules: {
      ...(opts.session ? { session: opts.session } : {}),
    },
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

type WriteCheckTool = Parameters<typeof checkWritePermissionForTool>[0]
const fakeEditTool = {
  name: 'Edit',
  getPath: (input: { file_path: string }) => input.file_path,
} as unknown as WriteCheckTool

const plain = join(proj, '.claude', 'plain.md') // benign real file
const carried = join(proj, '.claude', 'gnotes', 'newfile.md') // escapes worktree
const carriedLanding = join(fakeHome, '.claude', 'real-notes', 'newfile.md')

const savedOriginalCwd = getOriginalCwd()

beforeAll(() => {
  setOriginalCwd(proj)
})

afterAll(() => {
  setOriginalCwd(savedOriginalCwd)
  mock.restore()
  rmSync(farm, { recursive: true, force: true })
})

beforeEach(() => {
  _clearMatcherCacheForTesting()
  _clearPhysicalTwinsForTesting()
  _clearSymlinkEquivalencesForTesting()
})

const sessionCtx = (rules: string[]): ToolPermissionContext =>
  makeContext({ session: rules, workdir: proj })

const check = (filePath: string, ctx: ToolPermissionContext) =>
  checkWritePermissionForTool(fakeEditTool, { file_path: filePath }, ctx) as {
    behavior: string
    message?: string
    blockedPath?: string
    decisionReason?: {
      type: string
      reason?: string
      classifierApprovable?: boolean
    }
  }

describe('step 1.6 — REGRESSION SEC-1: carry-out deny/ask wins over the session .claude allow', () => {
  test('intermediate symlinked dir landing OUTSIDE the worktree is NOT allowed (proj + global grants)', () => {
    // The exact SEC-1 shape: both spellings match a .claude-scoped session rule
    // (requested -> /.claude/**, landing -> ~/.claude/**) so M2's all-spellings
    // check passes, but the landing is outside the working dir => carriedOut.
    // Pre-fix this returned 'allow'; the SEC-1 gate makes it fall through to the
    // 1.7 safety block, which asks with the carry-out merge.
    const result = check(
      carried,
      sessionCtx([PROJECT_CLAUDE_RULE, GLOBAL_CLAUDE_RULE]),
    )
    expect(result.behavior).not.toBe('allow')
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('safetyCheck')
    expect(result.decisionReason?.classifierApprovable).toBe(false)
    expect(result.blockedPath).toBe(carriedLanding)
    expect(result.message).toContain(
      `resolves through a symlink to ${carriedLanding}`,
    )
    expect(result.message).toContain(
      'which is outside the allowed working directories',
    )
  })

  test('the carried-out write asks identically to a plain outside-worktree write (carry-out semantics, no over-block)', () => {
    // Whatever the carry-out path produces for an out-of-worktree landing is the
    // expected outcome here — assert it is the human-only safety ask, NOT a deny
    // and NOT an allow, matching the step-1.7 carriedOut merge.
    const result = check(
      carried,
      sessionCtx([PROJECT_CLAUDE_RULE, GLOBAL_CLAUDE_RULE]),
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('safetyCheck')
  })
})

describe('step 1.6 — fast path preserved (no SEC-1 regression on benign writes)', () => {
  test('benign non-symlinked .claude file is STILL allowed with the project grant', () => {
    // carriedOut is null (no symlink move) => the SEC-1 gate is a no-op and the
    // intended step-1.6 bypass behaves exactly as before the change.
    const result = check(plain, sessionCtx([PROJECT_CLAUDE_RULE]))
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason?.type).toBe('rule')
  })

  test('benign non-symlinked .claude file is STILL allowed even with BOTH grants present', () => {
    // Proves the gate keys on carriedOut, not on the mere presence of a global
    // rule: a real (non-carried) .claude write keeps the fast-path allow.
    const result = check(
      plain,
      sessionCtx([PROJECT_CLAUDE_RULE, GLOBAL_CLAUDE_RULE]),
    )
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason?.type).toBe('rule')
  })
})
