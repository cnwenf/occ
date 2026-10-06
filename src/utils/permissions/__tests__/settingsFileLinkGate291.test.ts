/**
 * CC 2.1.291 (cluster C item 1, security 🔒) — write-permission gate for
 * paths reached through a settings-file link (official `y1` settings branch,
 * @~206563452, verbatim from the 2.1.291 linux-x64 ELF):
 *
 *   if(S){let R=ol(),x=w.map((A)=>TE(Ke(A))),
 *     I=x.map((A)=>R.get(A)).find((A)=>A!==void 0),
 *     L=I===void 0||x.includes(TE(I))?"":
 *       ` The Claude Code settings file ${ZI(I)} leads here through a link.`;
 *     return{safe:!1,
 *       message:`Claude requested permissions to write to ${ad(e)}, but you
 *         haven't granted it yet.${L}`,
 *       classifierApprovable:I===void 0,
 *       circuitBreaker:"claudeSettingsFile"}}
 *
 * with the trigger `S=Mrr(w)!=="none"` whose "certain literal" arm is
 * `hf=nMe∪…` — i.e. ANY path in the link table (or an `il` settings path)
 * fires the branch. This is the actual 289→291 fix: editing the TARGET of a
 * symlinked settings file previously never reached the settings gate.
 *
 * ZI(I) → OCC `formatPathForPermissionMessage` (sanitize + 160-char truncate;
 * official To=160). ad(e) (the 291-global display wrapper) is out of item-1
 * scope; OCC keeps the raw `${path}` interpolation like every other OCC
 * write message.
 *
 * Note (doc deviation, binary-verified): writing the symlinked settings file
 * ITSELF yields classifierApprovable FALSE — I is defined (the landing
 * spelling is registered) so `classifierApprovable:I===void 0` is false. The
 * suffix is suppressed there because TE(I) is itself among the checked
 * spellings (`x.includes(TE(I))`).
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

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { getOriginalCwd, setOriginalCwd } = await import(
  '../../../bootstrap/state.js'
)
const {
  _clearMatcherCacheForTesting,
  checkPathSafetyForAutoEdit,
  checkWritePermissionForTool,
  formatPathForPermissionMessage,
} = await import('../filesystem.js')
const {
  _resetSettingsFileLinksCacheForTesting,
  _setSettingsLinkClockForTesting,
} = await import('../settingsFileLinks.js')
const { _clearPhysicalTwinsForTesting, _clearSymlinkEquivalencesForTesting } =
  await import('../symlinkEquivalences.js')

function makeContext(
  opts: { workdir?: string; mode?: ToolPermissionContext['mode'] } = {},
): ToolPermissionContext {
  return {
    mode: opts.mode ?? 'default',
    additionalWorkingDirectories: new Map(
      opts.workdir !== undefined
        ? [
            [
              opts.workdir,
              { path: opts.workdir, source: 'userSettings' as const },
            ],
          ]
        : [],
    ),
    alwaysAllowRules: {},
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
let proj: string
let savedOriginalCwd: string
let savedConfigDirEnv: string | undefined
let savedCoworkEnv: string | undefined

function mkCfg(name: string): string {
  const dir = join(farm, `cfg-${name}`)
  mkdirSync(dir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = dir
  _resetSettingsFileLinksCacheForTesting()
  return dir
}

const baseMsg = (p: string): string =>
  `Claude requested permissions to write to ${p}, but you haven't granted it yet.`
const linkSuffix = (settingsPath: string): string =>
  ` The Claude Code settings file ${formatPathForPermissionMessage(settingsPath)} leads here through a link.`

type UnsafeResult = {
  safe: false
  message: string
  classifierApprovable: boolean
  circuitBreaker?: string
}

beforeAll(() => {
  farm = realpathSync(mkdtempSync(join(tmpdir(), 'occ-sflg291-')))
  proj = join(farm, 'proj')
  mkdirSync(proj)
  savedOriginalCwd = getOriginalCwd()
  savedConfigDirEnv = process.env.CLAUDE_CONFIG_DIR
  savedCoworkEnv = process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
  delete process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
  setOriginalCwd(proj)
})

afterAll(() => {
  setOriginalCwd(savedOriginalCwd)
  if (savedConfigDirEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDirEnv
  if (savedCoworkEnv === undefined)
    delete process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
  else process.env.CLAUDE_CODE_USE_COWORK_PLUGINS = savedCoworkEnv
  rmSync(farm, { recursive: true, force: true })
})

beforeEach(() => {
  _resetSettingsFileLinksCacheForTesting()
  _setSettingsLinkClockForTesting(undefined)
  _clearMatcherCacheForTesting()
  _clearPhysicalTwinsForTesting()
  _clearSymlinkEquivalencesForTesting()
})

describe('checkPathSafetyForAutoEdit — settings-link branch (CC 2.1.291 y1)', () => {
  test('write to the TARGET of a symlinked settings file → prompt + link sentence + not classifier-approvable + circuit breaker', () => {
    const cfg = mkCfg('target')
    const settingsPath = join(cfg, 'settings.json')
    const target = join(farm, 'gate-target.json')
    writeFileSync(target, '{}')
    symlinkSync(target, settingsPath)

    const result = checkPathSafetyForAutoEdit(target) as UnsafeResult

    expect(result.safe).toBe(false)
    expect(result.message).toBe(baseMsg(target) + linkSuffix(settingsPath))
    expect(result.classifierApprovable).toBe(false)
    expect(result.circuitBreaker).toBe('claudeSettingsFile')
  })

  test('write to an INTERMEDIATE spelling on the walk → same gate', () => {
    const cfg = mkCfg('mid')
    const settingsPath = join(cfg, 'settings.json')
    const mid = join(farm, 'gate-mid.json')
    const final = join(farm, 'gate-final.json')
    writeFileSync(final, '{}')
    symlinkSync(final, mid)
    symlinkSync(mid, settingsPath)

    const result = checkPathSafetyForAutoEdit(mid) as UnsafeResult

    expect(result.safe).toBe(false)
    expect(result.message).toBe(baseMsg(mid) + linkSuffix(settingsPath))
    expect(result.classifierApprovable).toBe(false)
    expect(result.circuitBreaker).toBe('claudeSettingsFile')
  })

  test('write to the symlinked settings file ITSELF → gate fires, self-reference suffix suppressed', () => {
    const cfg = mkCfg('self')
    const settingsPath = join(cfg, 'settings.json')
    const target = join(farm, 'gate-self-target.json')
    writeFileSync(target, '{}')
    symlinkSync(target, settingsPath)

    const result = checkPathSafetyForAutoEdit(settingsPath) as UnsafeResult

    expect(result.safe).toBe(false)
    // x.includes(TE(I)) → no suffix.
    expect(result.message).toBe(baseMsg(settingsPath))
    // classifierApprovable:I===void 0 — I IS defined here → false (binary
    // semantics; the gap doc's test bullet claiming true contradicts its own
    // verbatim decompile).
    expect(result.classifierApprovable).toBe(false)
    expect(result.circuitBreaker).toBe('claudeSettingsFile')
  })

  test('write to a NORMAL settings file → unchanged message, classifierApprovable as before', () => {
    const cfg = mkCfg('normal')
    const settingsPath = join(cfg, 'settings.json')
    writeFileSync(settingsPath, '{}')

    const result = checkPathSafetyForAutoEdit(settingsPath) as UnsafeResult

    expect(result.safe).toBe(false)
    expect(result.message).toBe(baseMsg(settingsPath))
    expect(result.classifierApprovable).toBe(true)
    // The 291 gate always carries the marker on the settings branch (it was
    // already present in 289's dB — binary-verified).
    expect(result.circuitBreaker).toBe('claudeSettingsFile')
  })

  test('non-settings .claude config file → old branch untouched (no circuit breaker)', () => {
    mkCfg('untouched')
    const commandsDir = join(proj, '.claude', 'commands')
    mkdirSync(commandsDir, { recursive: true })
    const cmdFile = join(commandsDir, 'foo.md')
    writeFileSync(cmdFile, '# hi')

    const result = checkPathSafetyForAutoEdit(cmdFile) as UnsafeResult

    expect(result.safe).toBe(false)
    expect(result.message).toBe(baseMsg(cmdFile))
    expect(result.classifierApprovable).toBe(true)
    expect(result.circuitBreaker).toBeUndefined()
  })

  test('plain unrelated file → safe', () => {
    mkCfg('safefile')
    const plain = join(farm, 'plain.txt')
    writeFileSync(plain, 'ok')

    expect(checkPathSafetyForAutoEdit(plain)).toEqual({ safe: true })
  })
})

describe('checkWritePermissionForTool — circuitBreaker forwarding (official Yf @204082772)', () => {
  test('settings-link write ask carries decisionReason.circuitBreaker', () => {
    const cfg = mkCfg('fwd')
    const settingsPath = join(cfg, 'settings.json')
    const target = join(farm, 'fwd-target.json')
    writeFileSync(target, '{}')
    symlinkSync(target, settingsPath)

    const result = checkWritePermissionForTool(
      fakeEditTool,
      { file_path: target },
      makeContext({ workdir: farm }),
    ) as {
      behavior: string
      message: string
      decisionReason?: {
        type: string
        reason?: string
        classifierApprovable?: boolean
        circuitBreaker?: string
      }
    }

    expect(result.behavior).toBe('ask')
    expect(result.message).toBe(baseMsg(target) + linkSuffix(settingsPath))
    expect(result.decisionReason).toEqual({
      type: 'safetyCheck',
      reason: baseMsg(target) + linkSuffix(settingsPath),
      classifierApprovable: false,
      circuitBreaker: 'claudeSettingsFile',
    })
  })
})
