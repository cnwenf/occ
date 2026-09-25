/**
 * claude-code 2.1.282 managed-settings fail-closed policy machinery.
 *
 * Byte-exact port of the official 2.1.282 binary's policy-parse helpers
 * (minified names in comments). Every user-facing message string below was
 * extracted verbatim from /tmp/occ97b/package/claude (v2.1.282):
 *
 * - `nx`  → coerceStringBoolean        (string "true"/"false" → boolean)
 * - `rn`  → quoteRestrictive
 * - `tn`  → formatPolicyIssueDetail
 * - `Li`  → formatPolicyIssueList      (@194777083)
 * - `Xe`  → RESTRICTIVE_ENTRIES        (OCC-present keys only; the Ni/pn
 *                                       filters are data-driven, so absent
 *                                       official keys stay inert and land
 *                                       automatically if the schema grows)
 * - `pn`  → restrictiveByPath
 * - `eg`  → BLOCK_GRANTS
 * - `gn`  → GRANT_FLOORS
 * - `sn`  → hasNestedRestriction
 * - `mn`  → isRebuiltBlock
 * - `jo`  → unwrapToObjectSchema
 * - `ki`  → REMOTE_LIKE_BLOCKS
 * - `Ui`  → isSynthesizedObject
 * - `zi`  → synthesizeLockSkeleton
 * - `Oi`  → nullRemovalIssue
 * - `zo`  → withholdBlockGrants        (@194778000 window)
 * - `tg`  → wrapLeafField
 * - `Ki`  → rebuildBlockSchema
 * - `Ni`  → collectLockFields          (@194777350)
 * - `Ea`  → isPlainObject
 * - `oa`  → omitMatching
 *
 * STAGED (deliberately NOT ported here — see the 2.1.282 gap report):
 * - all `sandbox.*` hand-written restrictive paths (`mn` excludes sandbox
 *   exactly like the official, and the official's bespoke sandbox.credentials
 *   machinery is out of scope);
 * - the 7 official lock keys absent from the OCC schema
 *   (disableClaudeAiConnectors, disableCommandPluginSources,
 *   disableSideloadFlags, disableRemoteControl, disableWorkflows,
 *   disableArtifact, isolatePeerMachines) — RESTRICTIVE_ENTRIES only lists
 *   OCC-present keys, but every consumer filters against the live schema
 *   shape, so adding a key to both schema and table is all it takes;
 * - `managedMcpServers` coherence checks (`Ft`), policyHelper(s), the
 *   managed-settings.d merge-floor messages (Ql/ad/ld/removed/
 *   documentHasPolicyContent/Qxo/Kge) and `bi`'s per-entry marketplace
 *   enforceability warnings (`un`) — OCC's policySourceSanitizer already
 *   pre-filters unenforceable marketplace entries (CC 2.1.277 report_C C9).
 */
import { z } from 'zod/v4'
import { PERMISSION_MODES } from '../permissions/PermissionMode.js'

/**
 * One fail-closed parse issue, matching the official 2.1.282 `e({path,
 * message, ...})` callback records (Ko/pd). The sink in
 * policyStrictSchema.ts turns these into ValidationError records.
 */
export type PolicyIssue = {
  path: string
  message: string
  /** Informational: names the key at startup/doctor; value was still applied */
  statusOnly?: boolean
  /** OS-admin policy doc could not be parsed at all; blocks startup */
  startupFatal?: boolean
  /** The value was replaced by its restrictive (fail-closed) counterpart */
  substituted?: boolean
  /** This source's only policy content is fail-closed substitutions */
  onlySubstitutes?: boolean
}

export type PolicyIssueCallback = (issue: PolicyIssue) => void

/** A restrictive (fail-closed) value from the official `Xe` table. */
export type RestrictiveValue = boolean | string | readonly string[]

type RestrictiveEntry = {
  /** Settings path segments; length 1 = top-level key, length 2 = block.key */
  path: readonly string[]
  restrictive: RestrictiveValue
}

/**
 * OCC subset of the official `Xe()` restrictive-value table (2.1.282).
 * Order matches the official table so `collectLockFields` (Ni) and
 * `restrictiveByPath` (pn) see the same sequence. Official keys absent from
 * the OCC schema are omitted (see the STAGED note in the file header).
 */
export const RESTRICTIVE_ENTRIES: readonly RestrictiveEntry[] = [
  { path: ['allowManagedPermissionRulesOnly'], restrictive: true },
  { path: ['allowManagedHooksOnly'], restrictive: true },
  { path: ['allowManagedMcpServersOnly'], restrictive: true },
  { path: ['enforceAvailableModels'], restrictive: true },
  { path: ['disableAllHooks'], restrictive: true },
  { path: ['disableSkillShellExecution'], restrictive: true },
  { path: ['disableAgentView'], restrictive: true },
  { path: ['disableBundledSkills'], restrictive: true },
  { path: ['fastModePerSessionOptIn'], restrictive: true },
  { path: ['strictPluginOnlyCustomization'], restrictive: true },
  { path: ['disableAutoMode'], restrictive: 'disable' },
  { path: ['disableDeepLinkRegistration'], restrictive: 'disable' },
  { path: ['syncClaudeAiSkills'], restrictive: false },
  { path: ['syncClaudeAiPlugins'], restrictive: false },
  { path: ['useAutoModeDuringPlan'], restrictive: false },
  { path: ['skipDangerousModePermissionPrompt'], restrictive: false },
  { path: ['skipAutoPermissionPrompt'], restrictive: false },
  { path: ['enableAllProjectMcpServers'], restrictive: false },
  { path: ['channelsEnabled'], restrictive: false },
  { path: ['skipWebFetchPreflight'], restrictive: false },
  {
    path: ['maxEffortLevel'],
    restrictive: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { path: ['permissions', 'disableBypassPermissionsMode'], restrictive: 'disable' },
  { path: ['permissions', 'disableAutoMode'], restrictive: 'disable' },
  { path: ['autoMode', 'classifyAllShell'], restrictive: true },
  { path: ['worktree', 'bgIsolation'], restrictive: 'worktree' },
  { path: ['attribution', 'sessionUrl'], restrictive: false },
]

/** Official `ct` — top-level keys excluded from the onlySubstitutes tail check. */
export const TAIL_EXCLUDED_KEYS: readonly string[] = [
  'managedSourcesBehavior',
  'wslInheritsWindowsSettings',
]

/**
 * Structural view of a zod issue. The official `tn`/`Li` read `input`,
 * `code`, `message`, `expected`, `values`, `path`, and (for invalid_union)
 * `errors`/`note` — all present on zod v4 catch-context issues.
 */
export type PolicyZodIssue = {
  code?: string
  message?: string
  path?: ReadonlyArray<string | number>
  input?: unknown
  expected?: unknown
  values?: unknown
  errors?: ReadonlyArray<readonly PolicyZodIssue[]>
  note?: unknown
}

/** Official `nx`: coerce string-typed booleans written without quotes. */
export function coerceStringBoolean(value: unknown): unknown {
  return value === 'true' ? true : value === 'false' ? false : value
}

/** Official `rn`: quote strings, stringify everything else. */
export function quoteRestrictive(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value)
}

/** Official `Ea`: plain-object check (prototype-based, arrays excluded). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Official `oa`: copy of `obj` without keys whose value matches `predicate`. */
export function omitMatching(
  obj: Record<string, unknown>,
  predicate: (value: unknown) => boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!predicate(value)) result[key] = value
  }
  return result
}

/**
 * Official `tn`: compact human-readable detail for one zod issue, used inside
 * "was present but invalid (...)" messages. `pathOffset` slices leading path
 * segments already named by the message's own path.
 */
export function formatPolicyIssueDetail(
  issue: PolicyZodIssue | undefined,
  pathOffset = 0,
): string {
  const base =
    issue === undefined || issue.input === undefined
      ? 'failed validation'
      : issue.code === 'custom' && issue.message !== undefined
        ? issue.message
        : 'expected' in issue && typeof issue.expected === 'string'
          ? `expected ${issue.expected}`
          : 'values' in issue && Array.isArray(issue.values)
            ? `expected ${issue.values.map(quoteRestrictive).join(' or ')}`
            : 'failed validation'
  const path = (issue?.path ?? []).slice(pathOffset)
  if (path.length === 0) return base
  return path.every(segment => typeof segment === 'number')
    ? `${path.join('.')}: ${base}`
    : `nested value: ${base}`
}

/**
 * Official `Li` (@194777083): first non-empty issue message from a list,
 * recursing into invalid_union branches. Returns undefined when nothing
 * readable was found (callers fall back to "failed validation").
 */
export function formatPolicyIssueList(
  issues: readonly PolicyZodIssue[],
): string | undefined {
  for (const issue of issues) {
    const prefix =
      issue.path !== undefined && issue.path.length > 0
        ? `${issue.path.map(String).join('.')}: `
        : ''
    if (issue.code === 'invalid_union') {
      for (const branch of issue.errors ?? []) {
        const nested = formatPolicyIssueList(branch)
        if (nested !== undefined) return `${prefix}${nested}`
      }
      if (
        'note' in issue &&
        typeof issue.note === 'string' &&
        issue.note !== ''
      ) {
        return `${prefix}${issue.note}`
      }
    }
    if (issue.message !== '') return `${prefix}${issue.message}`
  }
  return undefined
}

let restrictiveByPathCache: Map<string, unknown> | undefined

/**
 * Official `pn`: memoized map of dotted nested paths ("permissions.
 * disableBypassPermissionsMode") → their restrictive value. Array-valued
 * restrictives normalize to their first element (official `nt(n)[0]`).
 */
export function restrictiveByPath(): ReadonlyMap<string, unknown> {
  restrictiveByPathCache ??= new Map(
    RESTRICTIVE_ENTRIES.flatMap(({ path, restrictive }) =>
      path.length > 1
        ? [[
            path.join('.'),
            Array.isArray(restrictive) ? restrictive[0] : restrictive,
          ]]
        : [],
    ),
  )
  return restrictiveByPathCache
}

type BlockGrantSpec = {
  /** Keys that restrict; if unreadable, grants in the same block are withheld */
  restrictions: readonly string[]
  /** Keys that grant; withheld when a restriction could not be read */
  grants: readonly string[]
  /** Withhold grants even when a restriction was only trimmed (autoMode) */
  withholdOnEntryDrop?: boolean
}

/** Official `eg`. sandbox.* entries kept for table fidelity (mn never routes sandbox here). */
export const BLOCK_GRANTS: ReadonlyMap<string, BlockGrantSpec> = new Map([
  [
    'permissions',
    {
      restrictions: ['deny', 'ask'],
      grants: ['allow', 'additionalDirectories', 'defaultMode'],
    },
  ],
  [
    'autoMode',
    {
      restrictions: ['soft_deny', 'hard_deny', 'deny'],
      grants: ['allow', 'environment'],
      withholdOnEntryDrop: true,
    },
  ],
  [
    'sandbox.network',
    { restrictions: ['deniedDomains'], grants: ['allowedDomains'] },
  ],
  [
    'sandbox.filesystem',
    { restrictions: ['denyWrite', 'denyRead'], grants: ['allowWrite', 'allowRead'] },
  ],
])

type GrantFloorSpec = {
  /** Normalize the parsed value; undefined = not a readable mode */
  read: (value: unknown) => string | undefined
  /** Values that neither grant nor restrict — never withheld */
  inert: ReadonlySet<string>
  /** Fail-closed floor substituted when grants are withheld */
  floor: string
}

/**
 * Official `gn`. The official `read` normalizes via `bm` (the "manual" alias)
 * before searching `[...$D, ...Eo(B3e())]`; OCC's defaultMode field is a plain
 * enum over PERMISSION_MODES (the schema already rejected anything else by the
 * time zo runs), so the read is a direct membership check.
 */
export const GRANT_FLOORS: ReadonlyMap<string, GrantFloorSpec> = new Map([
  [
    'permissions.defaultMode',
    {
      read: value =>
        typeof value === 'string'
          ? PERMISSION_MODES.find(mode => mode === value)
          : undefined,
      inert: new Set(['default', 'dontAsk', 'plan']),
      floor: 'default',
    },
  ],
])

/** Official `ki`: blocks whose synthesized skeletons never join the WeakSet. */
export const REMOTE_LIKE_BLOCKS: ReadonlySet<string> = new Set([
  'remoteTools',
  'remoteControl',
])

/** Official `sn`: does any nested restrictive path live under `prefix`? */
export function hasNestedRestriction(prefix: string): boolean {
  for (const key of restrictiveByPath().keys()) {
    if (key.startsWith(`${prefix}.`)) return true
  }
  return false
}

/** Official `mn`: top-level key rebuilt through the per-block salvage machinery. */
export function isRebuiltBlock(key: string): boolean {
  return key !== 'sandbox' && !key.startsWith('sandbox.') && hasNestedRestriction(key)
}

/**
 * Official `jo`: unwrap zod wrappers down to the inner ZodObject, if any.
 * The official unwraps three wrapper classes (pipe → `.out`, two via
 * `.unwrap()`); OCC's concrete block fields only need optional/nullable/
 * readonly/default/lazy/pipe/catch, all handled here. Returns undefined for
 * non-object schemas (leaf fields).
 */
export function unwrapToObjectSchema(schema: z.ZodType): z.ZodObject | undefined {
  let current: z.ZodType = schema
  for (;;) {
    if (current instanceof z.ZodPipe) {
      current = current.out as z.ZodType
    } else if (current instanceof z.ZodDefault || current instanceof z.ZodCatch) {
      current = (current as unknown as { def: { innerType: z.ZodType } }).def
        .innerType
    } else if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodLazy
    ) {
      current = (current as unknown as { unwrap(): z.ZodType }).unwrap()
    } else {
      break
    }
  }
  return current instanceof z.ZodObject ? current : undefined
}

/** Official `Ui`: was this value synthesized by the fail-closed machinery? */
export function isSynthesizedObject(
  synthesized: WeakSet<object>,
  value: unknown,
): boolean {
  return typeof value === 'object' && value !== null && synthesized.has(value)
}

/**
 * Official `zi`: restrictive-value skeleton for a block that could not be
 * read at all — every nested lock under `prefix` at its restrictive value.
 */
export function synthesizeLockSkeleton(
  prefix: string,
  objectSchema: z.ZodObject,
  exclude?: ReadonlySet<string>,
): Record<string, unknown> {
  const skeleton: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(
    objectSchema.shape as Record<string, z.ZodType>,
  )) {
    const path = `${prefix}.${key}`
    if (exclude?.has(path)) continue
    const restrictive = restrictiveByPath().get(path)
    const inner = unwrapToObjectSchema(field)
    if (restrictive !== undefined) skeleton[key] = restrictive
    else if (inner !== undefined && hasNestedRestriction(path)) {
      skeleton[key] = synthesizeLockSkeleton(path, inner, exclude)
    }
  }
  return skeleton
}

/** Official `Oi`: an explicit null is key removal, not a value. */
export function nullRemovalIssue(path: string, key: string): PolicyIssue {
  return {
    path,
    message: `"${key}" was null, which is read as key removal; this source does not set it.`,
    statusOnly: true,
  }
}

type RestrictionState = 'unreadable' | 'trimmed' | undefined

/**
 * Official `zo` (@194778000 window): when a block's restriction keys could
 * not be read, withhold the block's grant keys (delete them, or floor them
 * via GRANT_FLOORS). Mutates `data` — the official does the same; `data` is
 * always the parse-local copy built by rebuildBlockSchema, never shared state.
 * Returns the grant keys that were floored (they count as substituted).
 */
export function withholdBlockGrants(
  prefix: string,
  data: Record<string, unknown>,
  restrictionState: (key: string) => RestrictionState,
  onIssue: PolicyIssueCallback,
): string[] {
  const floored: string[] = []
  const spec = BLOCK_GRANTS.get(prefix)
  if (spec === undefined) return floored
  const unreadable = spec.restrictions.flatMap(key => {
    switch (restrictionState(key)) {
      case 'unreadable':
        return [`"${key}"`]
      case 'trimmed':
        return spec.withholdOnEntryDrop ? [`an entry of "${key}"`] : []
      case undefined:
        return []
    }
  })
  if (unreadable.length === 0) return floored
  const reason = unreadable.join(' and ')
  for (const key of spec.grants) {
    const floor = GRANT_FLOORS.get(`${prefix}.${key}`)
    const current = floor === undefined ? data[key] : floor.read(data[key])
    if (current === undefined || floor?.inert.has(current as string) === true) {
      continue
    }
    if (floor === undefined) delete data[key]
    else {
      data[key] = floor.floor
      floored.push(key)
    }
    onIssue({
      path: `${prefix}.${key}`,
      message:
        floor === undefined
          ? `"${key}" was withheld because ${reason} in the same block could not be read; it takes effect again once that is fixed.`
          : `"${key}" was withheld because ${reason} in the same block could not be read; treating it as ${quoteRestrictive(floor.floor)} until that is fixed.`,
      ...(floor !== undefined && { substituted: true }),
    })
  }
  return floored
}

/** Per-leaf state sets shared between wrapLeafField and rebuildBlockSchema. */
export type LeafWrapState = {
  /** Leaf was replaced by its restrictive value or grant floor */
  substituted: Set<string>
  /** Leaf was dropped entirely (could not be read) */
  ignored: Set<string>
  /** Array leaf was salvaged by dropping invalid entries */
  trimmed: Set<string>
}

/**
 * Official `tg`: wrap one leaf field with fail-closed catch behavior.
 * Strategies, in official order:
 * 1. nested restrictive value known (pn) → substitute it;
 * 2. grant floor known (gn) → substitute the floor;
 * 3. array field → salvage valid entries, drop invalid ones (trimmed);
 * 4. otherwise → ignore the field entirely.
 * The official unwraps two wrapper classes before attaching `.catch`; OCC's
 * leaf fields are concrete, so the catch attaches to the field directly
 * (behaviorally identical for every OCC field shape).
 */
export function wrapLeafField(
  path: string,
  field: z.ZodType,
  onIssue: PolicyIssueCallback,
  state: LeafWrapState,
): z.ZodType {
  const key = path.slice(path.lastIndexOf('.') + 1)
  const restrictive = restrictiveByPath().get(path)
  const floor = GRANT_FLOORS.get(path)
  return (field as z.ZodType<unknown>).catch(ctx => {
    const issues = (ctx.issues ?? ctx.error?.issues ?? []) as PolicyZodIssue[]
    if (restrictive !== undefined) {
      onIssue({
        path,
        message: `"${key}" was present but invalid (${formatPolicyIssueDetail(issues[0])}); treating it as ${quoteRestrictive(restrictive)}, its restrictive value, until it is fixed.`,
        substituted: true,
      })
      state.substituted.add(key)
      return restrictive
    }
    if (floor !== undefined) {
      onIssue({
        path,
        message: `"${key}" was present but invalid (${formatPolicyIssueDetail(issues[0])}); treating it as ${quoteRestrictive(floor.floor)} until it is fixed.`,
        substituted: true,
      })
      state.substituted.add(key)
      return floor.floor
    }
    if (field.safeParse([]).success) {
      const value = (ctx as { value?: unknown }).value
      if (Array.isArray(value)) {
        const invalidByIndex = new Map<number, string>()
        for (const issue of issues) {
          const index = issue.path?.[0]
          if (typeof index === 'number' && !invalidByIndex.has(index)) {
            invalidByIndex.set(index, formatPolicyIssueDetail(issue, 1))
          }
        }
        const salvaged = field.safeParse(
          value.filter((_, index) => !invalidByIndex.has(index)),
        )
        if (
          invalidByIndex.size > 0 &&
          invalidByIndex.size < value.length &&
          salvaged.success
        ) {
          for (const [index, detail] of invalidByIndex) {
            onIssue({
              path: `${path}[${index}]`,
              message: `Invalid entry was ignored (${detail}); it cannot take effect until it is fixed.`,
            })
          }
          state.trimmed.add(key)
          return salvaged.data
        }
      }
    }
    onIssue({
      path,
      message: `"${key}" was present but invalid (${formatPolicyIssueDetail(issues[0])}) and was ignored; it cannot take effect until it is fixed.`,
    })
    state.ignored.add(key)
    return undefined
  }) as z.ZodType
}

export type RebuildBlockOptions = {
  /** WeakSet of synthesized (fail-closed skeleton) objects — drives the tail check */
  synthesized?: WeakSet<object>
  /** The original (pre-wrap) field schema; used to normalize non-object inputs */
  strictField?: z.ZodType
  /** Dead in 2.1.282 (no caller passes it) — kept for port fidelity */
  skeletonExclude?: ReadonlySet<string>
  /** Dead in 2.1.282 (no caller passes it) — kept for port fidelity */
  override?: ReadonlyMap<string, z.ZodType>
}

/**
 * Official `Ki` (@194778000 window): rebuild one policy block (permissions,
 * autoMode, worktree, attribution, ...) so a single invalid nested value no
 * longer discards the whole block. Leaves are wrapped with `tg`; the block
 * transform applies null-removal records, grant withholding (`zo`), and —
 * when the block is not an object at all — the restrictive skeleton (`zi`).
 */
export function rebuildBlockSchema(
  prefix: string,
  objectSchema: z.ZodObject,
  onIssue: PolicyIssueCallback,
  options: RebuildBlockOptions = {},
): z.ZodType {
  const blockKey = prefix.slice(prefix.lastIndexOf('.') + 1)
  const state: LeafWrapState = {
    substituted: new Set(),
    ignored: new Set(),
    trimmed: new Set(),
  }
  const wrappedShape: Record<string, z.ZodType> = {}
  for (const [fieldKey, field] of Object.entries(
    objectSchema.shape as Record<string, z.ZodType>,
  )) {
    const fieldPath = `${prefix}.${fieldKey}`
    const inner = unwrapToObjectSchema(field)
    wrappedShape[fieldKey] =
      options.override?.get(fieldPath) ??
      (inner !== undefined && hasNestedRestriction(fieldPath)
        ? rebuildBlockSchema(fieldPath, inner, onIssue, {
            ...options,
            strictField: field,
          })
        : wrapLeafField(fieldPath, field, onIssue, state))
  }
  const rebuilt = objectSchema.extend(
    wrappedShape as Record<string, z.ZodTypeAny>,
  )
  return z
    .any()
    .transform((value: unknown) => {
      if (value === null) {
        onIssue(nullRemovalIssue(prefix, blockKey))
        return undefined
      }
      state.substituted.clear()
      state.ignored.clear()
      state.trimmed.clear()
      // The official only consults the original field schema for NON-object
      // inputs (e.g. attribution: true → normalized object via its transform).
      const strictResult =
        isPlainObject(value) || options.strictField === undefined
          ? undefined
          : options.strictField.safeParse(value)
      const base =
        strictResult?.success === true && isPlainObject(strictResult.data)
          ? (strictResult.data as Record<string, unknown>)
          : value
      const parsed = isPlainObject(base)
        ? rebuilt.safeParse(
            omitMatching(base, v => v === null || v === undefined),
          )
        : undefined
      if (!isPlainObject(base) || parsed?.success !== true) {
        const skeleton = synthesizeLockSkeleton(
          prefix,
          objectSchema,
          options.skeletonExclude,
        )
        const skeletonKeys = Object.keys(skeleton)
        onIssue({
          path: prefix,
          message:
            skeletonKeys.length > 0
              ? `"${blockKey}" was present but not an object; treating its locks as their restrictive values (${skeletonKeys.join(', ')}) until it is fixed.`
              : `"${blockKey}" was present but not an object and was ignored; it cannot take effect until it is fixed.`,
          ...(skeletonKeys.length > 0 && { substituted: true }),
        })
        if (skeletonKeys.length === 0) return undefined
        if (!REMOTE_LIKE_BLOCKS.has(prefix)) options.synthesized?.add(skeleton)
        return skeleton
      }
      for (const [fieldKey, fieldValue] of Object.entries(base)) {
        const fieldPath = `${prefix}.${fieldKey}`
        if (
          fieldValue === null &&
          (restrictiveByPath().has(fieldPath) || hasNestedRestriction(fieldPath))
        ) {
          onIssue(nullRemovalIssue(fieldPath, fieldKey))
        }
      }
      const data = { ...parsed.data } as Record<string, unknown>
      for (const grantKey of withholdBlockGrants(
        prefix,
        data,
        key =>
          state.ignored.has(key)
            ? 'unreadable'
            : state.trimmed.has(key)
              ? 'trimmed'
              : undefined,
        onIssue,
      )) {
        state.substituted.add(grantKey)
      }
      const defined = omitMatching(data, v => v === undefined)
      if (Object.keys(defined).length === 0) {
        return Object.values(base).some(v => v !== undefined) ? undefined : defined
      }
      const synthesized = options.synthesized
      if (
        synthesized !== undefined &&
        !REMOTE_LIKE_BLOCKS.has(prefix) &&
        Object.entries(defined).every(
          ([key, fieldValue]) =>
            state.substituted.has(key) ||
            isSynthesizedObject(synthesized, fieldValue),
        )
      ) {
        synthesized.add(defined)
      }
      return defined
    })
    .optional() as z.ZodType
}

export type LockField = {
  key: string
  restrictive: boolean | string
  field: z.ZodType
}

/**
 * Official `Ni` (@194777350): top-level lock fields eligible for the
 * string-coercion / disable-false / restrictive-substitution wrapper.
 * Skips, exactly like the official: multi-segment paths (handled per-block),
 * strictPluginOnlyCustomization (bespoke wrapper), disableAllHooks, non-scalar
 * restrictive values, keys absent from the schema, and lazy fields.
 */
export function collectLockFields(
  shape: Record<string, z.ZodType>,
): LockField[] {
  return RESTRICTIVE_ENTRIES.flatMap(({ path, restrictive }) => {
    if (
      path.length !== 1 ||
      path[0] === 'strictPluginOnlyCustomization' ||
      path[0] === 'disableAllHooks' ||
      (typeof restrictive !== 'boolean' && typeof restrictive !== 'string')
    ) {
      return []
    }
    const key = path[0]!
    const field = shape[key]
    if (field === undefined || field instanceof z.ZodLazy) return []
    return [{ key, restrictive, field }]
  })
}
