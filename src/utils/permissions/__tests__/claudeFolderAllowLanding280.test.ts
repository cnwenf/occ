/**
 * OCC-134 security-review follow-up (M2) — step 1.6 `.claude/**` session-allow
 * bypass must judge EVERY spelling of the write path, not just the requested
 * one. filesystem.ts step 1.6 (binary-ordered between the 1.55 unresolved deny
 * and the 1.7 safety checks) lets a session-scoped `/.claude/**` grant skip the
 * dangerous-path safety block; before the fix a symlink INSIDE `.claude/` whose
 * landing point is outside (e.g. `~/.claude/notes.md -> ~/.ssh/authorized_keys`)
 * was allowed on the strength of the requested path alone.
 *
 * The fix mirrors step 4's `matchingAllowRuleForAllSpellings` / step 3's
 * acceptEdits all-spellings requirement: allow only when the requested path AND
 * every descriptor spelling (resolved symlink targets/landings) matches a
 * .claude-scoped session allow rule (`isClaudeFolderScopedRuleContent`).
 *
 * Farm layout (all under realpath'd tmpdir `farmReal`):
 *   proj/                                  (working dir + originalCwd)
 *     .claude/plain.md                     (plain file)
 *     .claude/notes.md   -> ../../outside/secret.txt  (leaf escaping the wd)
 *     .claude/escape.md  -> ../important.txt          (leaf escaping .claude,
 *                                                      landing inside the wd —
 *                                                      the exact M2 shape)
 *     .claude/internal.md -> plain.md                 (leaf staying inside)
 *     .claude/settings.json                           (always-dangerous file)
 *     .claude/skills/my-skill/SKILL.md                (narrow-grant target)
 *     important.txt                        (benign file outside .claude)
 *     src/.git/config                      (dangerous dir under a /src/** rule)
 *   outside/secret.txt
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
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

// The production dialog (usePermissionHandler.ts) adds `{toolName: 'Edit',
// ruleContent: '/.claude/**'}` as a SESSION rule, serialized into the context
// as `Edit(/.claude/**)`. rootPathForSource('session') =
// expandPath(getOriginalCwd()), so the test pins originalCwd to the proj dir.
const PROJECT_CLAUDE_RULE = 'Edit(/.claude/**)'
const SKILL_RULE = 'Edit(/.claude/skills/my-skill/**)'
const SRC_RULE = 'Edit(/src/**)'

function makeContext(opts: {
  session?: string[]
  userSettings?: string[]
  workdir: string
}): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map([
      [opts.workdir, { path: opts.workdir, source: 'userSettings' as const }],
    ]),
    alwaysAllowRules: {
      ...(opts.session ? { session: opts.session } : {}),
      ...(opts.userSettings ? { userSettings: opts.userSettings } : {}),
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

let farm: string
let farmReal: string
let proj: string
let outside: string
let plain: string // proj/.claude/plain.md
let notes: string // proj/.claude/notes.md -> ../../outside/secret.txt
let escape: string // proj/.claude/escape.md -> ../important.txt
let internal: string // proj/.claude/internal.md -> plain.md
let secret: string // outside/secret.txt
let important: string // proj/important.txt
let claudeSettings: string // proj/.claude/settings.json
let skillFile: string // proj/.claude/skills/my-skill/SKILL.md
let gitConfig: string // proj/src/.git/config

const savedOriginalCwd = getOriginalCwd()

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), 'occ-claude-allow-'))
  farmReal = realpathSync(farm)
  proj = join(farmReal, 'proj')
  outside = join(farmReal, 'outside')
  mkdirSync(join(proj, '.claude', 'skills', 'my-skill'), { recursive: true })
  mkdirSync(join(proj, 'src', '.git'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(proj, '.claude', 'plain.md'), 'ok')
  writeFileSync(join(proj, '.claude', 'settings.json'), '{}')
  writeFileSync(join(proj, '.claude', 'skills', 'my-skill', 'SKILL.md'), '# s')
  writeFileSync(join(proj, 'important.txt'), 'benign')
  writeFileSync(join(proj, 'src', '.git', 'config'), '[core]')
  writeFileSync(join(outside, 'secret.txt'), 'top secret')
  symlinkSync(join('..', '..', 'outside', 'secret.txt'), join(proj, '.claude', 'notes.md'))
  symlinkSync(join('..', 'important.txt'), join(proj, '.claude', 'escape.md'))
  symlinkSync('plain.md', join(proj, '.claude', 'internal.md'))
  plain = join(proj, '.claude', 'plain.md')
  notes = join(proj, '.claude', 'notes.md')
  escape = join(proj, '.claude', 'escape.md')
  internal = join(proj, '.claude', 'internal.md')
  secret = join(outside, 'secret.txt')
  important = join(proj, 'important.txt')
  claudeSettings = join(proj, '.claude', 'settings.json')
  skillFile = join(proj, '.claude', 'skills', 'my-skill', 'SKILL.md')
  gitConfig = join(proj, 'src', '.git', 'config')
  setOriginalCwd(proj)
})

afterAll(() => {
  setOriginalCwd(savedOriginalCwd)
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

describe('step 1.6 — session /.claude/** grant still works for real .claude files', () => {
  test('plain file inside .claude is allowed (bypass predates and survives the fix)', () => {
    const result = check(plain, sessionCtx([PROJECT_CLAUDE_RULE]))
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason?.type).toBe('rule')
  })

  test('symlink whose landing stays inside .claude is allowed (all spellings match)', () => {
    const result = check(internal, sessionCtx([PROJECT_CLAUDE_RULE]))
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason?.type).toBe('rule')
  })
})

describe('step 1.6 — REGRESSION M2: every spelling must match the .claude-scoped rule', () => {
  test('symlink escaping .claude but landing INSIDE the working dir is NOT allowed', () => {
    // The exact M2 shape: requested proj/.claude/escape.md matches '/.claude/**',
    // but the landing proj/important.txt does not. Pre-fix this returned
    // 'allow' (requested path checked alone); now it falls through to the 1.7
    // safety block (.claude segment) and asks.
    const result = check(escape, sessionCtx([PROJECT_CLAUDE_RULE]))
    expect(result.behavior).not.toBe('allow')
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('safetyCheck')
  })

  test('symlink escaping the working dir entirely is NOT allowed (ask merges the resolves sentence)', () => {
    // ~/.claude/notes.md -> ~/.ssh/authorized_keys analog.
    const result = check(notes, sessionCtx([PROJECT_CLAUDE_RULE]))
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('safetyCheck')
    expect(result.decisionReason?.classifierApprovable).toBe(false)
    expect(result.blockedPath).toBe(secret)
    expect(result.message).toContain(
      `resolves through a symlink to ${secret}`,
    )
  })

  test('without any .claude grant the same paths ask (baseline, no over-allow)', () => {
    expect(check(plain, sessionCtx([])).behavior).toBe('ask')
    expect(check(escape, sessionCtx([])).behavior).toBe('ask')
    expect(check(notes, sessionCtx([])).behavior).toBe('ask')
  })
})

describe('step 1.6 — scope guards (pre-existing semantics, regression-locked)', () => {
  test('a persistent userSettings /.claude/** grant does NOT fire the session-only bypass', () => {
    const ctx = makeContext({
      userSettings: [PROJECT_CLAUDE_RULE],
      workdir: proj,
    })
    const result = check(plain, ctx)
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('safetyCheck')
  })

  test('narrowed skill grant allows the skill file but not settings.json', () => {
    const allowed = check(skillFile, sessionCtx([SKILL_RULE]))
    expect(allowed.behavior).toBe('allow')
    expect(allowed.decisionReason?.type).toBe('rule')

    const settings = check(claudeSettings, sessionCtx([SKILL_RULE]))
    expect(settings.behavior).toBe('ask')
  })

  test('broad grant exposes settings.json (documented broad-pattern scope) but a non-.claude session rule never bypasses safety', () => {
    // SRC_RULE matches gitConfig but is NOT .claude-scoped: step 1.6 must
    // refuse to let it skip the dangerous-path safety block.
    const result = check(gitConfig, sessionCtx([SRC_RULE]))
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason?.type).toBe('safetyCheck')
  })

  test('important.txt (outside .claude, benign) is untouched by the .claude grant', () => {
    const result = check(important, sessionCtx([PROJECT_CLAUDE_RULE]))
    // No rule matches the landing-path spelling set for a plain allow here:
    // step 1.6's first-match check fails (path is not under .claude), safety
    // passes, and the default-mode fallthrough asks.
    expect(result.behavior).toBe('ask')
  })
})
