/**
 * CC 2.1.291 (cluster C item 1, security 🔒) — settings-file link spelling
 * table (official `ol()` @206550974 + `nMe` membership probe).
 *
 * Official shape ported (verbatim from the 2.1.291 linux-x64 ELF):
 *   var gf=2000;function ol(){let e=new Map;try{let n=Lb(),
 *   r=D(n===void 0?Cr():[...Cr(),n]),s=qL(),g=r.join("\x00"),
 *   h=SJo().monotonicNow(),w=s.settingsFileLinks;
 *   if(w!==void 0&&w.key===g&&h-w.builtAt<gf)return w.files;
 *   s.settingsFileLinks={key:g,builtAt:h,files:e};let S=new Map;
 *   for(let R of r){let x=bi(R);
 *     if(x.unresolved)t(`permissions: the walk of settings file ${R} did not
 *       reach its end; only the links it met are recorded`);
 *     if(!x.leafIsSymlink)continue;
 *     for(let I of x.spellings)for(let L of D([I,$n(I)]))if(!il(L))
 *       S.set(TE(L),R)}
 *   return s.settingsFileLinks={key:g,builtAt:h,files:S},S}
 *   catch(n){return c(Error("the walk of the settings links threw; for two
 *     seconds no settings file counts as a link"),{cause:n}),e}}
 *   function nMe(e){return ol().has(TE(Ke(e)))||il(e)}
 *
 * Key identity translations (binary-verified): Ke=expandPath (export alias
 * `Ke as expandPath` @225547173), TE=per-segment case fold of normalize,
 * il=isClaudeSettingsPath (OCC analogue; the managed-dir locate part of the
 * official il is doc item-2 territory and not in this wave), bi(R)=
 * resolveWritePathDescriptor, D=Set dedupe, gf=2000ms TTL.
 *
 * Fail-degraded semantics: the EMPTY map `e` is stashed into the cache BEFORE
 * the walk, so a throw leaves "no settings file counts as a link" cached for
 * the remainder of the 2-second window (official catch returns `e`).
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

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// Snapshot real exports BEFORE mocking; restore in afterAll so the mocks
// don't leak into other test files sharing this worker (OCC-97 pattern).
const actualFsOperations = { ...(await import('../../fsOperations.js')) }
const actualDebug = { ...(await import('../../debug.js')) }
const actualLog = { ...(await import('../../log.js')) }

/** Captured logForDebugging calls (official `t(...)`). */
let debugLogs: Array<{ message: string; level?: string }> = []
/** Captured logError calls (official `c(...)`). */
let logErrors: unknown[] = []
/** When set, resolveWritePathDescriptor delegates here (official `bi` throw). */
let walkOverride: ((p: string) => unknown) | undefined

mock.module('../../fsOperations.js', () => ({
  ...actualFsOperations,
  resolveWritePathDescriptor: (p: string) =>
    walkOverride
      ? walkOverride(p)
      : (
          actualFsOperations.resolveWritePathDescriptor as (
            q: string,
          ) => unknown
        )(p),
}))
mock.module('../../debug.js', () => ({
  ...actualDebug,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    debugLogs.push({ message, level: opts?.level })
  },
}))
mock.module('../../log.js', () => ({
  ...actualLog,
  logError: (error: unknown) => {
    logErrors.push(error)
  },
}))

const { getOriginalCwd, setOriginalCwd } = await import(
  '../../../bootstrap/state.js'
)
const {
  getSettingsFileLinkMap,
  isSettingsFileLink,
  settingsLinkFoldKey,
  SETTINGS_LINK_TTL_MS,
  _resetSettingsFileLinksCacheForTesting,
  _setSettingsLinkClockForTesting,
} = await import('../settingsFileLinks.js')
const { _clearPhysicalTwinsForTesting, _clearSymlinkEquivalencesForTesting } =
  await import('../symlinkEquivalences.js')

let farm: string
let proj: string
let savedOriginalCwd: string
let savedConfigDirEnv: string | undefined
let savedCoworkEnv: string | undefined
let fakeNow = 0

/** Creates a fresh config-home dir and points CLAUDE_CONFIG_DIR at it. */
function mkCfg(name: string): string {
  const dir = join(farm, `cfg-${name}`)
  mkdirSync(dir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = dir
  _resetSettingsFileLinksCacheForTesting()
  return dir
}

beforeAll(() => {
  farm = realpathSync(mkdtempSync(join(tmpdir(), 'occ-sfl291-')))
  proj = join(farm, 'proj')
  mkdirSync(proj)
  savedOriginalCwd = getOriginalCwd()
  savedConfigDirEnv = process.env.CLAUDE_CONFIG_DIR
  savedCoworkEnv = process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
  delete process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
  setOriginalCwd(proj)
})

afterAll(() => {
  mock.module('../../fsOperations.js', () => ({ ...actualFsOperations }))
  mock.module('../../debug.js', () => ({ ...actualDebug }))
  mock.module('../../log.js', () => ({ ...actualLog }))
  setOriginalCwd(savedOriginalCwd)
  if (savedConfigDirEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDirEnv
  if (savedCoworkEnv === undefined)
    delete process.env.CLAUDE_CODE_USE_COWORK_PLUGINS
  else process.env.CLAUDE_CODE_USE_COWORK_PLUGINS = savedCoworkEnv
  rmSync(farm, { recursive: true, force: true })
})

beforeEach(() => {
  debugLogs = []
  logErrors = []
  walkOverride = undefined
  fakeNow = 0
  _resetSettingsFileLinksCacheForTesting()
  _setSettingsLinkClockForTesting(() => fakeNow)
  _clearPhysicalTwinsForTesting()
  _clearSymlinkEquivalencesForTesting()
})

describe('settingsFileLinks — official ol() link table (CC 2.1.291)', () => {
  test('TTL constant matches the official gf=2000', () => {
    expect(SETTINGS_LINK_TTL_MS).toBe(2000)
  })

  test('symlinked settings file: every walk spelling maps back to the original settings path', () => {
    const cfg = mkCfg('leaf')
    const settingsPath = join(cfg, 'settings.json')
    const target = join(farm, 'leaf-target.json')
    writeFileSync(target, '{}')
    symlinkSync(target, settingsPath)

    const map = getSettingsFileLinkMap()

    // The landing target is registered and points at the original settings path.
    expect(map.get(settingsLinkFoldKey(target))).toBe(settingsPath)
    expect(isSettingsFileLink(target)).toBe(true)
    // The requested settings spelling itself is `il` (internal) → NOT registered.
    expect(map.has(settingsLinkFoldKey(settingsPath))).toBe(false)
    // The settings path still counts as a settings link via the `il` arm of nMe.
    expect(isSettingsFileLink(settingsPath)).toBe(true)
    // An unrelated path is not a settings link.
    expect(isSettingsFileLink(join(farm, 'unrelated.json'))).toBe(false)
  })

  test('symlink chain: intermediate spellings are registered too', () => {
    const cfg = mkCfg('chain')
    const settingsPath = join(cfg, 'settings.json')
    const mid = join(farm, 'chain-mid.json')
    const final = join(farm, 'chain-final.json')
    writeFileSync(final, '{}')
    symlinkSync(final, mid)
    symlinkSync(mid, settingsPath)

    const map = getSettingsFileLinkMap()

    expect(map.get(settingsLinkFoldKey(mid))).toBe(settingsPath)
    expect(map.get(settingsLinkFoldKey(final))).toBe(settingsPath)
    expect(isSettingsFileLink(mid)).toBe(true)
    expect(isSettingsFileLink(final)).toBe(true)
  })

  test('non-symlink settings file: leafIsSymlink false → nothing registered', () => {
    const cfg = mkCfg('plain')
    const settingsPath = join(cfg, 'settings.json')
    writeFileSync(settingsPath, '{}')

    const map = getSettingsFileLinkMap()

    expect(map.size).toBe(0)
    // nMe still fires for the settings file itself via the `il` arm.
    expect(isSettingsFileLink(settingsPath)).toBe(true)
    expect(isSettingsFileLink(join(farm, 'rand.json'))).toBe(false)
  })

  test('symlinked config-home DIRECTORY plus symlinked leaf: landing registered, dir-hop spelling NOT (binary-verified wn onHop)', () => {
    const cfgReal = join(farm, 'cfg-dirlink-real')
    mkdirSync(cfgReal)
    const cfgLink = join(farm, 'cfg-dirlink')
    symlinkSync(cfgReal, cfgLink)
    process.env.CLAUDE_CONFIG_DIR = cfgLink
    _resetSettingsFileLinksCacheForTesting()
    const settingsPath = join(cfgLink, 'settings.json')
    const target = join(farm, 'dirlink-target.json')
    writeFileSync(target, '{}')
    symlinkSync(target, join(cfgReal, 'settings.json'))

    const map = getSettingsFileLinkMap()

    // The landing target of the leaf link IS registered (leaf-hop composed
    // spelling) and maps to the ORIGINAL settings path.
    expect(map.get(settingsLinkFoldKey(target))).toBe(settingsPath)
    expect(isSettingsFileLink(target)).toBe(true)
    // Binary-verified (291 wn @202223657): onHop is
    // `({composed:R,leaf:T,text:W})=>{if(T)s.add(R),c=!0;if(n==="screen"&&
    // dt(W))g(R)}` — a NON-leaf (directory) hop's composed spelling is only
    // queued in "screen" mode, and bi=wn(R,"permission") @202223164. So the
    // official link table does NOT register `cfgReal/settings.json` — the
    // gap doc's "全量登记 x.spellings" bullet reads ol() correctly but
    // x.spellings itself excludes permission-mode dir-hop spellings.
    expect(map.has(settingsLinkFoldKey(join(cfgReal, 'settings.json')))).toBe(
      false,
    )
  })

  test('unresolved walk (symlink loop): degraded log + only the links it met are recorded', () => {
    const cfg = mkCfg('loop')
    const settingsPath = join(cfg, 'settings.json')
    const a = join(farm, 'loop-a.json')
    const b = join(farm, 'loop-b.json')
    symlinkSync(b, a)
    symlinkSync(a, b)
    symlinkSync(a, settingsPath)

    const map = getSettingsFileLinkMap()

    expect(debugLogs.some(
      l =>
        l.message ===
        `permissions: the walk of settings file ${settingsPath} did not reach its end; only the links it met are recorded`,
    )).toBe(true)
    expect(map.get(settingsLinkFoldKey(a))).toBe(settingsPath)
    expect(map.get(settingsLinkFoldKey(b))).toBe(settingsPath)
  })

  test('TTL: no re-walk within 2s, re-walk after 2s, immediate re-walk when the settings set changes', () => {
    const cfg = mkCfg('ttl')
    const settingsPath = join(cfg, 'settings.json')
    const targetA = join(farm, 'ttl-a.json')
    const targetB = join(farm, 'ttl-b.json')
    writeFileSync(targetA, '{}')
    writeFileSync(targetB, '{}')
    symlinkSync(targetA, settingsPath)

    fakeNow = 1000
    const map1 = getSettingsFileLinkMap()
    expect(map1.has(settingsLinkFoldKey(targetA))).toBe(true)

    // Re-point the link; within the TTL the cached table must be returned.
    rmSync(settingsPath)
    symlinkSync(targetB, settingsPath)

    fakeNow = 1000 + SETTINGS_LINK_TTL_MS - 500
    const map2 = getSettingsFileLinkMap()
    expect(map2.has(settingsLinkFoldKey(targetA))).toBe(true)
    expect(map2.has(settingsLinkFoldKey(targetB))).toBe(false)

    // Past the TTL the walk runs again and sees the new target.
    fakeNow = 1000 + SETTINGS_LINK_TTL_MS + 1
    const map3 = getSettingsFileLinkMap()
    expect(map3.has(settingsLinkFoldKey(targetA))).toBe(false)
    expect(map3.has(settingsLinkFoldKey(targetB))).toBe(true)

    // A changed settings-path set (cache key) forces an immediate rebuild
    // even inside the TTL window.
    const cfg2 = join(farm, 'cfg-ttl2')
    mkdirSync(cfg2)
    const settings2 = join(cfg2, 'settings.json')
    const target2 = join(farm, 'ttl-c.json')
    writeFileSync(target2, '{}')
    symlinkSync(target2, settings2)
    process.env.CLAUDE_CONFIG_DIR = cfg2
    fakeNow = 1000 + SETTINGS_LINK_TTL_MS + 500
    const map4 = getSettingsFileLinkMap()
    expect(map4.has(settingsLinkFoldKey(target2))).toBe(true)
    expect(map4.has(settingsLinkFoldKey(targetB))).toBe(false)
  })

  test('walk throw: fail-degraded empty map cached for the window, error reported, no bubble', () => {
    const cfg = mkCfg('throw')
    const settingsPath = join(cfg, 'settings.json')
    const target = join(farm, 'throw-target.json')
    writeFileSync(target, '{}')
    symlinkSync(target, settingsPath)

    const boom = new Error('synthetic walk failure')
    walkOverride = () => {
      throw boom
    }
    fakeNow = 500

    // The throw must not bubble (official catch degrades to the empty map).
    const map1 = getSettingsFileLinkMap()
    expect(map1.size).toBe(0)
    expect(isSettingsFileLink(target)).toBe(false)
    expect(logErrors.length).toBe(1)
    const reported = logErrors[0] as Error
    expect(reported.message).toBe(
      'the walk of the settings links threw; for two seconds no settings file counts as a link',
    )
    expect(reported.cause).toBe(boom)

    // The EMPTY map was stashed before the walk → the degraded answer is
    // cached for the rest of the window (no second throw, no second report).
    fakeNow = 500 + SETTINGS_LINK_TTL_MS - 1
    const map2 = getSettingsFileLinkMap()
    expect(map2.size).toBe(0)
    expect(logErrors.length).toBe(1)

    // After the window expires with the walk healthy again, the real table
    // comes back (the target IS a settings link again).
    walkOverride = undefined
    fakeNow = 500 + SETTINGS_LINK_TTL_MS + 1
    const map3 = getSettingsFileLinkMap()
    expect(map3.get(settingsLinkFoldKey(target))).toBe(settingsPath)
    expect(logErrors.length).toBe(1)
  })
})
