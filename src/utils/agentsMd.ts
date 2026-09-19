/**
 * AGENTS.md project-instruction support (Claude Code 2.1.277 `agents-md` plugin).
 *
 * This module is a faithful port of the official v277 `agents-md` plugin's pure
 * logic, recovered byte-for-byte from the official 2.1.277 linux-x64 ELF
 * (plugin region ~222427200–222436600 and the string table ~101780024). Every
 * mode string, setting key, event name, filename and user-facing string here is
 * byte-copied from the binary — nothing is invented.
 *
 * The official ships this as a plugin that post-processes the `prompt.context`
 * `instructionFiles` list. OCC has no plugin runtime, so the discovery is wired
 * directly into `getMemoryFiles()` in `claudemd.ts`; this module holds the
 * mode resolution, dedup, insertion, framing, provider gate and telemetry-row
 * helpers (all side-effect free except the provider/env reads) so they can be
 * unit-tested in isolation.
 *
 * Official symbol → OCC export map (from the ELF export table):
 *   AGENTS_NAMES/CLAUDE_NAMES/DEFAULT_MODE/MODES/DROPPED_KINDS/FEATURE_NAME,
 *   LOAD_EVENT/MODE_EVENT/NESTED_EVENT/WALK_FAILED_REASON/MAIN_LOOP,
 *   modeOf(he)/legacyModeOf(Fe)/modeChoiceOf(F)/loadRowOf(Ae)/modeRowOf(Me)/
 *   nestedRowOf(Se)/loadCountsOf(Ie)/loadMarkOf(we),
 *   normalSpellingOf(p)/isBelow(D)/isFileAt(q)/projectDirOf(O)/chainRootOf(S)/
 *   insertionIndex(V)/withProjectFiles(Ee)/unseenFiles(J)/isProjectOwn(E)/
 *   isClaudeFileOnWalk(ge)/isKeptWithoutInstructions(ye)/nestedFrame(ue)/
 *   outsideClaudeDirs(xe)/absoluteOf(ce).
 */

import { getEffectiveAPIProvider } from './model/providers.js'
import type { MemoryType } from './memory/types.js'

/** The structural shape these helpers operate on (OCC's MemoryFileInfo is a superset). */
export type InstructionFile = {
  path: string
  content: string
  parent?: string
  type: MemoryType
}

// --- Byte-copied constants (ELF string table + plugin region) --------------

/** `var z=["AGENTS.md",".claude/AGENTS.md"]` */
export const AGENTS_NAMES = ['AGENTS.md', '.claude/AGENTS.md'] as const

/** `var N=["CLAUDE.md",".claude/CLAUDE.md","CLAUDE.local.md"]` */
export const CLAUDE_NAMES = [
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'CLAUDE.local.md',
] as const

/** `var _="claude-md-or-agents-md"` (DEFAULT_MODE) */
export const DEFAULT_MODE = 'claude-md-or-agents-md'

/** `var C=["claude-md","claude-md-or-agents-md","claude-md-and-agents-md","managed-only"]` (MODES) */
export const MODES = [
  'claude-md',
  'claude-md-or-agents-md',
  'claude-md-and-agents-md',
  'managed-only',
] as const

export type InstructionFilesMode = (typeof MODES)[number]

/**
 * Legacy `projectInstructions` plugin-option → `instructionFiles` mode map.
 * `var be={none:"managed-only",claude:"claude-md","agents-fallback":"claude-md-or-agents-md",both:"claude-md-and-agents-md"}`
 */
export const LEGACY_MODE_MAP: Record<string, InstructionFilesMode> = {
  none: 'managed-only',
  claude: 'claude-md',
  'agents-fallback': 'claude-md-or-agents-md',
  both: 'claude-md-and-agents-md',
}

/** Legacy `projectInstructions` option values (v276 plugin). */
export const LEGACY_PROJECT_INSTRUCTIONS_VALUES = [
  'claude',
  'agents-fallback',
  'both',
  'none',
] as const

/** `var T=["project","local","user"]` (DROPPED_KINDS) — kept for managed-only. */
export const DROPPED_KINDS = ['project', 'local', 'user'] as const

/** `var b="agents_md"` (FEATURE_NAME) */
export const FEATURE_NAME = 'agents_md'

/** `var X="agents_md_load"` (LOAD_EVENT) */
export const LOAD_EVENT = 'agents_md_load'

/** `var te="agents_md_mode"` (MODE_EVENT) */
export const MODE_EVENT = 'agents_md_mode'

/** `var oe="agents_md_nested"` (NESTED_EVENT) */
export const NESTED_EVENT = 'agents_md_nested'

/** `var ee="walk_failed"` (WALK_FAILED_REASON) */
export const WALK_FAILED_REASON = 'walk_failed'

/** `var Y="main"` (MAIN_LOOP) */
export const MAIN_LOOP = 'main'

/** GrowthBook gate name (`ql("tengu_agents_md_mod", W)`). */
export const AGENTS_MD_GATE = 'tengu_agents_md_mod'

/** Plugin name (`var K="agents-md"`). */
export const PLUGIN_NAME = 'agents-md'

/** Plugin description (`var H=...`), byte-copied. */
export const PLUGIN_DESCRIPTION =
  "AGENTS.md as project instructions: by default loaded where the project has no CLAUDE.md; by its instructionFiles option, loaded beside CLAUDE.md, left out, or with the project instructions dropped"

/** `instructionFiles` setting description (USER_CONFIG `re`), byte-copied. */
export const INSTRUCTION_FILES_DESCRIPTION = `"claude-md": CLAUDE.md only, loaded by the engine as today. "claude-md-or-agents-md" (default): a project with no CLAUDE.md of its own gets its AGENTS.md files instead, loaded exactly where and how CLAUDE.md would be. "claude-md-and-agents-md": AGENTS.md files are loaded beside CLAUDE.md (a file CLAUDE.md already imports or links to is not loaded twice). "managed-only": the project's and your own instruction files are dropped; the organization's managed CLAUDE.md and memory stay.`

/** `instructionFiles` setting title (USER_CONFIG `re.title`), byte-copied. */
export const INSTRUCTION_FILES_TITLE = 'Project instructions'

/** One-shot notice prefix (`"no CLAUDE.md found; AGENTS.md loaded: "`), byte-copied. */
export const AGENTS_LOADED_NOTICE_PREFIX = 'no CLAUDE.md found; AGENTS.md loaded: '

/** Deprecation notice fragments (session.start `s.ui.log`), byte-copied. */
export function projectInstructionsHonouredNotice(mode: string): string {
  return `option projectInstructions in settings is honoured for now, read as instructionFiles ${mode}; set instructionFiles to ${mode} and remove projectInstructions`
}
export function projectInstructionsIgnoredNotice(mode: string): string {
  return `option projectInstructions in settings is not read: instructionFiles ${mode} is set; remove projectInstructions`
}

// --- Mode resolution (he / Fe + the qe() prelude) --------------------------

/** `var he=(e)=>C.find((t)=>t===e)??_` — coerce a settings value to a valid mode. */
export function modeOf(value: unknown): InstructionFilesMode {
  return (MODES as readonly string[]).find(m => m === value) as
    | InstructionFilesMode
    | undefined ?? (DEFAULT_MODE as InstructionFilesMode)
}

/**
 * `function Fe(e){if(e===void 0)return;return(typeof e==="string"?be[e]:void 0)??"claude-md"}`
 * Map a legacy `projectInstructions` value to a mode. `undefined` passes through;
 * any other string (known or not) resolves to its mapping or `"claude-md"`.
 */
export function legacyModeOf(
  value: unknown,
): InstructionFilesMode | undefined {
  if (value === undefined) return undefined
  return (
    (typeof value === 'string'
      ? LEGACY_MODE_MAP[value]
      : undefined) ?? 'claude-md'
  ) as InstructionFilesMode
}

export type ResolvedInstructionMode = {
  /** The effective mode (`o` in qe). */
  mode: InstructionFilesMode
  /** `i` — legacy `projectInstructions` is set AND `instructionFiles` is at default. */
  legacyHonoured: boolean
  /** `l` — legacy `projectInstructions` is unset. */
  legacyUnset: boolean
  /** The legacy-mapped mode (`n`), if any. */
  legacyMode: InstructionFilesMode | undefined
}

/**
 * The `qe()` prelude, verbatim:
 *   `let r=he(t.instructionFiles),n=Fe(t.projectInstructions),i=n!==void 0&&r===_,o=i?n:r,l=n===void 0`
 */
export function resolveInstructionMode(settings: {
  instructionFiles?: unknown
  projectInstructions?: unknown
}): ResolvedInstructionMode {
  const r = modeOf(settings.instructionFiles)
  const n = legacyModeOf(settings.projectInstructions)
  const legacyHonoured = n !== undefined && r === DEFAULT_MODE
  const mode = legacyHonoured ? (n as InstructionFilesMode) : r
  const legacyUnset = n === undefined
  return { mode, legacyHonoured, legacyUnset, legacyMode: n }
}

// --- Path helpers (p / D / q / O / S) --------------------------------------

/** `var p=(e)=>e.replaceAll("\\","/").replace(/(?<=.)\/+$/,"")` (normalSpellingOf). */
export function normalSpellingOf(path: string): string {
  return path.replaceAll('\\', '/').replace(/(?<=.)\/+$/, '')
}

/** `var D=(e,t)=>p(e).startsWith(`${p(t)}/`)` (isBelow): is `e` strictly under `t`. */
export function isBelow(e: string, t: string): boolean {
  return normalSpellingOf(e).startsWith(`${normalSpellingOf(t)}/`)
}

/** `var q=(e,t)=>p(e.path)===p(t)` (isFileAt). */
export function isFileAt(file: { path: string }, path: string): boolean {
  return normalSpellingOf(file.path) === normalSpellingOf(path)
}

/**
 * `function O(e){let t=p(e),r=t.lastIndexOf("/.claude/"),n=r===-1?t.lastIndexOf("/"):r;return n<=0?"/":t.slice(0,n)}`
 * (projectDirOf): the project directory a file belongs to (strips `/.claude/…` or the last segment).
 */
export function projectDirOf(path: string): string {
  const t = normalSpellingOf(path)
  const r = t.lastIndexOf('/.claude/')
  const n = r === -1 ? t.lastIndexOf('/') : r
  return n <= 0 ? '/' : t.slice(0, n)
}

/**
 * `function S(e,t){let r=new Set([e.path]),{path:n,parent:i}=e;while(i!==void 0&&!r.has(i))r.add(i),n=i,i=t.get(i)?.parent;return n}`
 * (chainRootOf): follow the `parent` include-chain up to its root path (cycle-safe).
 */
export function chainRootOf(
  file: InstructionFile,
  byPath: Map<string, InstructionFile>,
): string {
  const seen = new Set<string>([file.path])
  let path = file.path
  let parent = file.parent
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(parent)
    path = parent
    parent = byPath.get(parent)?.parent
  }
  return path
}

// --- Kind predicates (E / ye / ge) -----------------------------------------

function kindOf(type: MemoryType): 'project' | 'local' | 'user' | 'managed' | 'memory' {
  switch (type) {
    case 'Project':
      return 'project'
    case 'Local':
      return 'local'
    case 'User':
      return 'user'
    case 'Managed':
      return 'managed'
    case 'AutoMem':
    case 'TeamMem':
      return 'memory'
    default:
      return 'memory'
  }
}

/** `var E=(e)=>e.kind==="project"||e.kind==="local"` (isProjectOwn). */
export function isProjectOwn(file: InstructionFile): boolean {
  const k = kindOf(file.type)
  return k === 'project' || k === 'local'
}

/** `var ye=(e)=>!T.includes(e.kind)` (isKeptWithoutInstructions) — managed-only keeps these. */
export function isKeptWithoutInstructionType(type: MemoryType): boolean {
  return !(DROPPED_KINDS as readonly string[]).includes(kindOf(type))
}

/**
 * `function ge(e,t){if(!(E(e)&&e.parent===void 0&&N.some((o)=>p(e.path).endsWith(`/${o}`))))return!1;let n=O(e.path),i=p(t);return n===i||D(i,n)}`
 * (isClaudeFileOnWalk): is `file` a project-owned, root-level CLAUDE-named file
 * whose project dir is `rootDir` or an ancestor of it.
 */
export function isClaudeFileOnWalk(
  file: InstructionFile,
  rootDir: string,
): boolean {
  if (
    !(
      isProjectOwn(file) &&
      file.parent === undefined &&
      (CLAUDE_NAMES as readonly string[]).some(o =>
        normalSpellingOf(file.path).endsWith(`/${o}`),
      )
    )
  ) {
    return false
  }
  const n = projectDirOf(file.path)
  const i = normalSpellingOf(rootDir)
  return n === i || isBelow(i, n)
}

/**
 * The `m.some((d)=>ge(d,x))` hasClaude check, adapted: is `file` a root-level
 * (not @imported) CLAUDE-named project/local file that was actually loaded.
 * In the official this is `isClaudeFileOnWalk(file, sessionRoot)`; OCC's
 * loaded set already only contains files from the ancestor walk, so the
 * rootDir ancestry clause is implied.
 */
export function isLoadedClaudeFile(file: InstructionFile): boolean {
  return (
    isProjectOwn(file) &&
    file.parent === undefined &&
    (CLAUDE_NAMES as readonly string[]).some(o =>
      normalSpellingOf(file.path).endsWith(`/${o}`),
    )
  )
}

// --- Dedup + insertion (J / V / Ee) ----------------------------------------

/**
 * `function J(e,t){let r=new Set(t.map((o)=>p(o.path))),n=new Set(t.filter(E).map((o)=>o.content.trim())),i=[];for(let o of e){let l=p(o.path),h=o.content.trim();if(!(r.has(l)||h!==""&&n.has(h)))r.add(l),i.push(o)}return i}`
 * (unseenFiles): drop candidates already present by normalized path, or whose
 * non-empty trimmed content matches an existing project/local file (import dedup).
 */
export function unseenFiles<T extends InstructionFile>(
  candidates: T[],
  existing: InstructionFile[],
): T[] {
  const seenPaths = new Set(existing.map(o => normalSpellingOf(o.path)))
  const seenContents = new Set(
    existing.filter(isProjectOwn).map(o => o.content.trim()),
  )
  const out: T[] = []
  for (const o of candidates) {
    const l = normalSpellingOf(o.path)
    const h = o.content.trim()
    if (!(seenPaths.has(l) || (h !== '' && seenContents.has(h)))) {
      seenPaths.add(l)
      out.push(o)
    }
  }
  return out
}

/**
 * `function V(e,t){let r=new Map(e.map((l)=>[l.path,l])),n=e.findIndex((l)=>E(l)&&D(O(S(l,r)),t));if(n!==-1)return n;let i=e.findLastIndex(E);if(i!==-1)return i+1;let o=e.findIndex((l)=>l.kind==="memory");return o===-1?e.length:o}`
 * (insertionIndex): where to splice AGENTS files for project dir `t`.
 */
export function insertionIndex(
  list: InstructionFile[],
  targetDir: string,
): number {
  const byPath = new Map(list.map(l => [l.path, l]))
  const n = list.findIndex(
    l => isProjectOwn(l) && isBelow(projectDirOf(chainRootOf(l, byPath)), targetDir),
  )
  if (n !== -1) return n
  const i = findLastIndex(list, isProjectOwn)
  if (i !== -1) return i + 1
  const o = list.findIndex(l => kindOf(l.type) === 'memory')
  return o === -1 ? list.length : o
}

/**
 * `function Ee(e,t){if(t.length===0)return e;let r=[...e],n=new Map(t.map((o)=>[o.path,o])),i=new Map;for(let o of t){let l=O(S(o,n));i.set(l,[...i.get(l)??[],o])}for(let[o,l]of i)r.splice(V(r,o),0,...l);return r}`
 * (withProjectFiles): insert new AGENTS files into the existing list, grouped by
 * their (chain-root) project dir, at each group's insertion index.
 */
export function withProjectFiles<T extends InstructionFile>(
  existing: T[],
  newFiles: T[],
): T[] {
  if (newFiles.length === 0) return existing
  const r = [...existing]
  const byPath = new Map<string, InstructionFile>(newFiles.map(o => [o.path, o]))
  const groups = new Map<string, T[]>()
  for (const o of newFiles) {
    const l = projectDirOf(chainRootOf(o, byPath))
    groups.set(l, [...(groups.get(l) ?? []), o])
  }
  for (const [dir, files] of groups) {
    r.splice(insertionIndex(r, dir), 0, ...files)
  }
  return r
}

// --- Nested-injection helpers (ue / xe) ------------------------------------

/** `var ue=(e)=>`Contents of ${e.path}:\n\n${e.content}`` (nestedFrame). */
export function nestedFrame(file: { path: string; content: string }): string {
  return `Contents of ${file.path}:\n\n${file.content}`
}

/**
 * `function xe(e,t){let r=new Set(t.map((n)=>n.dir));return e.filter((n)=>!r.has(n.dir))}`
 * (outsideClaudeDirs): in or-mode, drop AGENTS ancestors whose directory also
 * holds a CLAUDE-named file.
 */
export function outsideClaudeDirs<T extends { dir: string }>(
  agentsDirs: T[],
  claudeDirs: { dir: string }[],
): T[] {
  const claudeDirSet = new Set(claudeDirs.map(n => n.dir))
  return agentsDirs.filter(n => !claudeDirSet.has(n.dir))
}

/**
 * `function ce(e,t,r){...}` (absoluteOf): resolve a Read `file_path` to an
 * absolute path, expanding a leading `~` against the home dir (`r`).
 */
export function absoluteOf(
  filePath: string,
  cwd: string,
  home: string | undefined,
): string {
  if ((filePath === '~' || filePath.startsWith('~/')) && home !== undefined) {
    const base = home.replace(/(?<=.)[\\/]+$/, '')
    return filePath === '~' ? base : `${base}${sepOf(base)}${filePath.slice(2)}`
  }
  return /^(?:[A-Za-z]:)?[\\/]/.test(filePath)
    ? filePath
    : `${cwd}${sepOf(cwd)}${filePath}`
}

function sepOf(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

// --- Provider gate ---------------------------------------------------------

/**
 * Changelog: "not yet on Bedrock, Vertex or Foundry". The official gates plugin
 * availability behind `canLoadBuiltinHooksModules() && GrowthBook('tengu_agents_md_mod')`;
 * the provider exclusion is enforced remotely. OCC has no GrowthBook backend, so
 * the feature is default-ON (per the changelog) except on the three named
 * third-party providers.
 */
export function isAgentsMdFeatureAvailable(): boolean {
  const provider = getEffectiveAPIProvider()
  return provider !== 'bedrock' && provider !== 'vertex' && provider !== 'foundry'
}

// --- Telemetry rows (Ie / Ae / Me / Se / we) -------------------------------

/** `function Ie(e,t,r){...}` (loadCountsOf). */
export function loadCountsOf(
  files: InstructionFile[],
  isYielded: boolean,
  isWalkFailed: boolean,
): {
  fileCount: number
  importCount: number
  totalContentLength: number
  isYielded: boolean
  isWalkFailed: boolean
} {
  const importCount = files.reduce(
    (i, o) => i + (o.parent === undefined ? 0 : 1),
    0,
  )
  return {
    fileCount: files.length - importCount,
    importCount,
    totalContentLength: files.reduce((i, o) => i + o.content.length, 0),
    isYielded,
    isWalkFailed,
  }
}

/** `var we=(e)=>e.isWalkFailed?{feature:b,kind:"sad",reason:ee}:{feature:b,kind:"ok"}` (loadMarkOf). */
export function loadMarkOf(counts: { isWalkFailed: boolean }): {
  feature: string
  kind: 'sad' | 'ok'
  reason?: string
} {
  return counts.isWalkFailed
    ? { feature: FEATURE_NAME, kind: 'sad', reason: WALK_FAILED_REASON }
    : { feature: FEATURE_NAME, kind: 'ok' }
}

// --- small utils -----------------------------------------------------------

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i] as T)) return i
  }
  return -1
}
