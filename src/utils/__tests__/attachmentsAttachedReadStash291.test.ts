import {
  afterAll,
  afterEach,
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
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { generateFileAttachment } from '../attachments.js'
import { expandPath } from '../path.js'
import { _clearMatcherCacheForTesting } from '../permissions/filesystem.js'
import { _clearPhysicalTwinsForTesting } from '../permissions/symlinkEquivalences.js'
import {
  type ResolutionMode,
  setSessionWritePermissionStashForTesting,
  type StashEntry,
  SymlinkResolutionStash,
} from '../permissions/symlinkResolutionStash.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.290 changelog (security) — cluster B3:
 *   "Fixed an `@`-mention under the read block or `--restricted` being able to
 *    read a file outside the working directories through a link changed
 *    mid-read"
 *
 * Official v290 wiring (byte-verified @213690234 / @213690750 / @213674546):
 * every mention-pipeline `FileReadTool.call` gets a context whose toolUseId is
 * a fresh `attached-read-${randomUUID()}` with the check-time landing
 * spellings stashed under it — but ONLY when reads are blocked (`sy(ctx)`):
 *
 *   let xe = Qb.call(Te, h ? await LMe(he,be,e) : e)
 *   async function LMe(e,n,r){let s=`attached-read-${c3n()}`,g=jv(e);
 *     r.session.writePermissionStash.stash(s,g,n,"read"); ...
 *     return {...r,toolUseId:s}}
 *
 * Before 290 (and in OCC until this port) mention reads called
 * `FileReadTool.call` with NO prior `checkPermissions`, so no stash entry
 * existed and `assertSymlinkResolutionsUnchangedForRead` fell back to a fresh
 * resolution — the gate no-oped and a link flipped between the mention deny
 * check and the read escaped.
 *
 * `--restricted` / `blockReadsOutsideWorkingDirectories` / `prompt.mention`
 * are N-A in OCC (grep-proven, doc §B3), so `hasReadDenyRules` is the whole
 * `sy` predicate here.
 */

const SECRET_CONTENT = 'TOP-SECRET-KEY'
const PUBLIC_CONTENT = 'PUBLIC-CONTENT'

function makePermissionContext(
  opts: { deny?: string[] } = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

function makeToolUseContext(
  toolPermissionContext: ToolPermissionContext,
): ToolUseContext {
  return {
    options: { mcpClients: [], tools: [], mainLoopModel: 'claude-opus-5' },
    abortController: new AbortController(),
    readFileState: new Map(),
    dynamicSkillDirTriggers: new Set(),
    nestedMemoryAttachmentTriggers: new Set(),
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
  } as unknown as ToolUseContext
}

type StashCall = {
  toolUseId: string | undefined
  path: string
  resolutions: StashEntry
  mode: ResolutionMode
}

/** Recording stash; optionally runs a hook right after each stash() — the
 *  test's "attacker flips the link between check and read" window. */
class RecordingStash extends SymlinkResolutionStash {
  readonly calls: StashCall[] = []

  constructor(private readonly afterStash: () => void = () => {}) {
    super()
  }

  stash(
    toolUseId: string | undefined,
    path: string,
    resolutions: StashEntry,
    mode: ResolutionMode = 'write',
  ): void {
    super.stash(toolUseId, path, resolutions, mode)
    this.calls.push({ toolUseId, path, resolutions: [...resolutions], mode })
    this.afterStash()
  }
}

let farm: string
let farmReal: string
let secretDir: string
let openDir: string
let linkPath: string
let plainPath: string
let stash: RecordingStash

function makeLink(name: string, target: string): string {
  const path = join(farmReal, name)
  rmSync(path, { force: true })
  symlinkSync(target, path)
  return path
}

beforeAll(() => {
  farm = mkdtempSync(join(tmpdir(), 'occ-attachedread291-'))
  farmReal = realpathSync(farm)
  secretDir = join(farmReal, 'secret')
  openDir = join(farmReal, 'open')
  mkdirSync(secretDir, { recursive: true })
  mkdirSync(openDir, { recursive: true })
  writeFileSync(join(secretDir, 'a.txt'), SECRET_CONTENT)
  writeFileSync(join(openDir, 'b.txt'), PUBLIC_CONTENT)
  plainPath = join(openDir, 'plain.txt')
  writeFileSync(plainPath, PUBLIC_CONTENT)
})

afterAll(() => {
  rmSync(farm, { recursive: true, force: true })
})

beforeEach(() => {
  _clearMatcherCacheForTesting()
  _clearPhysicalTwinsForTesting()
  stash = new RecordingStash()
  setSessionWritePermissionStashForTesting(stash)
  linkPath = makeLink('link.txt', join(openDir, 'b.txt'))
})

afterEach(() => {
  setSessionWritePermissionStashForTesting(undefined)
})

function denySecretContext(): ToolPermissionContext {
  return makePermissionContext({ deny: [`Read(/${secretDir}/**)`] })
}

async function mention(
  filename: string,
  toolPermissionContext: ToolPermissionContext,
) {
  return await generateFileAttachment(
    filename,
    makeToolUseContext(toolPermissionContext),
    'tengu_test_at_mention_success',
    'tengu_test_at_mention_error',
    'at-mention',
  )
}

describe('CC 2.1.290 B3 — mention reads stash under an attached-read toolUseId', () => {
  test('reads blocked → spellings stashed under attached-read-<uuid>, key = expandPath(file)', async () => {
    const attachment = await mention(linkPath, denySecretContext())

    expect(attachment).not.toBeNull()
    expect(stash.calls).toHaveLength(1)
    const call = stash.calls[0]
    expect(call?.toolUseId).toMatch(/^attached-read-[0-9a-f-]{36}$/)
    expect(call?.mode).toBe('read')
    expect(call?.path).toBe(expandPath(linkPath))
    expect(call?.resolutions).toContain(linkPath)
    expect(call?.resolutions).toContain(join(openDir, 'b.txt'))
  })

  test('the stashed entry is consumed by the FileReadTool assert (gate really ran)', async () => {
    await mention(linkPath, denySecretContext())

    // consume() is one-shot and drops every entry of the toolUseId — an
    // unconsumed entry would mean FileReadTool.call never reached the assert.
    const toolUseId = stash.calls[0]?.toolUseId
    expect(toolUseId).toBeDefined()
    expect(
      stash.consume(toolUseId, expandPath(linkPath), 'read'),
    ).toBeUndefined()
  })

  test('stable symlink → attachment carries the landing content', async () => {
    const attachment = await mention(linkPath, denySecretContext())

    expect(attachment?.type).toBe('file')
    if (attachment?.type === 'file') {
      expect(JSON.stringify(attachment.content)).toContain(PUBLIC_CONTENT)
      expect(JSON.stringify(attachment.content)).not.toContain(SECRET_CONTENT)
    }
  })

  test('link flipped between the deny check and the read → refused, not attached', async () => {
    // The flip runs inside stash(), i.e. after the check-time spellings were
    // recorded and before FileReadTool.call recomputes them.
    setSessionWritePermissionStashForTesting(
      new RecordingStash(() => {
        makeLink('link.txt', join(secretDir, 'a.txt'))
      }),
    )
    const flipping = getSessionStashCalls()

    const attachment = await mention(linkPath, denySecretContext())

    expect(attachment).toBeNull()
    expect(flipping).toHaveLength(1)
  })

  test('nothing blocked → no stash wiring at all (official sy gate), read still works', async () => {
    const attachment = await mention(linkPath, makePermissionContext())

    expect(stash.calls).toHaveLength(0)
    expect(attachment?.type).toBe('file')
    if (attachment?.type === 'file') {
      expect(JSON.stringify(attachment.content)).toContain(PUBLIC_CONTENT)
    }
  })

  test('plain file under a deny rule → stashed and attached', async () => {
    const attachment = await mention(plainPath, denySecretContext())

    expect(stash.calls).toHaveLength(1)
    expect(attachment?.type).toBe('file')
  })
})

/** Helper: the stash currently installed by the flip test. */
function getSessionStashCalls(): StashCall[] {
  // The flip test installs its own RecordingStash; reach it through the same
  // session accessor the production code uses.
  const active = getSessionStashForTest()
  return active instanceof RecordingStash ? active.calls : []
}

// Imported lazily so the helper above reads the live singleton.
const { getSessionWritePermissionStash: getSessionStashForTest } = await import(
  '../permissions/symlinkResolutionStash.js'
)
