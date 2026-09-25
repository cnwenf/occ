/**
 * claude-code 2.1.282 strict policy-source settings schema.
 *
 * Byte-exact port of the official 2.1.282 `Ko(onIssue, sourceLabel)` builder
 * plus the `pd` issue sink and the `jdn` "document is not a JSON object"
 * records. Used for POLICY sources only (remote managed settings, MDM
 * plist/registry, managed-settings.json + drop-ins, HKCU). Non-policy sources
 * keep the whole-file all-or-nothing `SettingsSchema().safeParse` behavior —
 * the official does the same (SDK inline `--settings` uses the plain schema,
 * binary `X3e`/`ay`).
 *
 * Official build order (all message strings extracted verbatim from
 * /tmp/occ97b/package/claude v2.1.282, Ko @194785637 window):
 *   1. generic per-field catch ("This field was ignored.")
 *   2. prepend/appendPlugins guarded variant ("read as unset.")
 *   3. wslInheritsWindowsSettings bespoke wrapper (guarded — key absent in OCC)
 *   4. strictKnownMarketplaces / blockedMarketplaces (`bi`)
 *   5. allowedMcpServers / deniedMcpServers (`Ei`)
 *   6. lock-field wrappers (`Ni` loop) + strictPluginOnlyCustomization bespoke (`Mi`)
 *   7. enabledPlugins / availableModels / allowedHttpHookUrls /
 *      httpHookAllowedEnvVars / allowedChannelPlugins (`vo`) /
 *      gatewayInternalNetworks / forceLoginOrgUUID overrides
 *   8. per-block salvage rebuild (`Ki` via policyLocks.ts)
 *   9. passthrough + onlySubstitutes tail transform
 *
 * Every override is guarded by `key in shape` so the machinery is data-driven:
 * official keys absent from the OCC schema stay inert, and land automatically
 * once both the schema and RESTRICTIVE_ENTRIES grow them.
 *
 * STAGED (in official Ko, deliberately not ported — see gap report):
 * - managedMcpServers coherence checks (`Ft`) — key absent in OCC;
 * - policyHelper/policyHelpers static-payload machinery — keys absent in OCC;
 * - sandbox.credentials fail-closed skeleton — OCC sandbox fields keep the
 *   generic per-field catch (step 1);
 * - `bi`'s per-entry marketplace ENFORCEABILITY warnings (`un`: regex compile,
 *   github/git wildcard checks) — OCC's policySourceSanitizer already
 *   pre-filters unenforceable marketplace entries (CC 2.1.277 report_C C9);
 * - enabledPlugins PER-ENTRY salvage (needs the official plugin-id schema
 *   `Rk` for the `enabledPlugins.<invalid id>` path label) — OCC keeps the
 *   whole-map fail-closed catch below;
 * - allowedChannelPlugins string-entry coercion acceptance note (official
 *   `Up` coerces "plugin@marketplace" strings; the OCC entry schema is
 *   object-only, so string entries fail with the standard per-entry message);
 * - remote-consumer warning sanitization (`r$e`/Th: whitespace collapse,
 *   non-printable replacement, 512-char cap) and the `RAe` managedMcpServers
 *   sink filter — the official `pd` sink itself does neither.
 */
import { z } from 'zod/v4'
import { MarketplaceSourceSchema } from '../plugins/schemas.js'
import { logForDebugging } from '../debug.js'
import { plural } from '../stringUtils.js'
import {
  collectLockFields,
  coerceStringBoolean,
  formatPolicyIssueList,
  hasNestedRestriction,
  isPlainObject,
  isRebuiltBlock,
  isSynthesizedObject,
  type PolicyIssueCallback,
  type PolicyZodIssue,
  rebuildBlockSchema,
  TAIL_EXCLUDED_KEYS,
  unwrapToObjectSchema,
} from './policyLocks.js'
import {
  AllowedMcpServerEntrySchema,
  CUSTOMIZATION_SURFACES,
  DeniedMcpServerEntrySchema,
  SettingsSchema,
} from './types.js'
import type { ValidationError } from './validation.js'

type PolicyCatchContext = {
  issues?: PolicyZodIssue[]
  error?: { issues?: PolicyZodIssue[] }
}

/**
 * Official message extraction is `ctx.issues[0]?.message ?? fallback`; in the
 * official's bundled zod the catch-context issues carry `.message` directly.
 * In OCC's zod v4 the raw `ctx.issues` entries lack `.message` (it lives on
 * `ctx.error.issues`), so prefer the error's issues and fall back to the raw
 * ones — same observable text as the official.
 */
function firstIssueMessage(
  ctx: PolicyCatchContext,
  fallback: string,
): string {
  return (
    ctx.error?.issues?.[0]?.message ?? ctx.issues?.[0]?.message ?? fallback
  )
}

/** Official `Si` (@194777027): sentinel marking a stripped MCP allowlist entry. */
const MCP_ENTRY_STRIP_SENTINEL = Object.freeze({
  serverName: 'invalid-entry-stripped',
})

/** Official `nVn`: unreadable-gateway sentinel entry. */
const GATEWAY_UNREADABLE_SENTINEL = '(unreadable)'

/**
 * Official `bi` minus the staged `un` enforceability pass: per-entry
 * validation of a marketplace-source array with null → removal and an
 * all-invalid record for blockedMarketplaces.
 */
function marketplaceArraySchema(
  key: string,
  onIssue: PolicyIssueCallback,
): z.ZodType {
  const entrySchema = MarketplaceSourceSchema()
  return z
    .union([
      z.null().transform(() => undefined),
      z
        .array(z.any())
        .transform((entries: unknown[]) => {
          const kept: unknown[] = []
          for (const [index, entry] of entries.entries()) {
            const result = entrySchema.safeParse(entry)
            if (result.success) {
              kept.push(result.data)
              continue
            }
            onIssue({
              path: `${key}[${index}]`,
              message: `Invalid entry was ignored: ${formatPolicyIssueList(result.error.issues as PolicyZodIssue[]) ?? 'failed validation'}`,
            })
          }
          if (key === 'blockedMarketplaces' && entries.length > 0 && kept.length === 0) {
            onIssue({
              path: key,
              message:
                'Every entry of "blockedMarketplaces" was invalid; none of them can be enforced until it is fixed.',
            })
          }
          return kept
        }),
    ])
    .optional() as z.ZodType
}

/**
 * Official `Ei`: array whose entries are validated individually — invalid
 * entries are stripped (sentinel-filtered) with a per-entry record, the rest
 * keep enforcing.
 */
function salvagedEntryArraySchema(
  key: string,
  entrySchema: z.ZodType,
  onIssue: PolicyIssueCallback,
): z.ZodType {
  return z
    .array(
      (entrySchema as z.ZodType<unknown>).catch(ctx => {
        onIssue({
          path: `${key}[]`,
          message: `Invalid entry was ignored: ${firstIssueMessage(ctx as PolicyCatchContext, 'failed validation')}`,
        })
        return MCP_ENTRY_STRIP_SENTINEL
      }),
    )
    .transform(entries => entries.filter(entry => entry !== MCP_ENTRY_STRIP_SENTINEL))
    .optional() as z.ZodType
}

/**
 * Official `vo`: fail-closed allowlist array. Invalid entries are dropped
 * with per-entry records; if every entry was invalid (or the whole value is
 * unreadable) an EMPTY allowlist is enforced — never "no restriction".
 */
function failClosedAllowlistSchema(
  key: string,
  entrySchema: z.ZodType,
  onIssue: PolicyIssueCallback,
  emptyAllowlistText: string,
): z.ZodType {
  return z
    .array(z.any())
    .transform((entries: unknown[]) => {
      const kept: unknown[] = []
      for (const [index, entry] of entries.entries()) {
        const result = entrySchema.safeParse(entry)
        if (result.success) {
          kept.push(result.data)
          continue
        }
        const issue = result.error.issues[0] as PolicyZodIssue | undefined
        const detail =
          issue === undefined
            ? 'failed validation'
            : issue.path !== undefined && issue.path.length > 0
              ? `${issue.path.join('.')}: ${issue.message}`
              : (issue.message ?? 'failed validation')
        onIssue({
          path: `${key}[${index}]`,
          message: `Invalid entry was ignored: ${detail}`,
        })
      }
      if (entries.length > 0 && kept.length === 0) {
        onIssue({
          path: key,
          message: `Every entry of "${key}" was invalid; enforcing an empty allowlist (${emptyAllowlistText}) until it is fixed.`,
        })
      }
      return kept
    })
    .optional()
    .catch(() => {
      onIssue({
        path: key,
        message: `"${key}" was present but invalid; enforcing an empty allowlist (${emptyAllowlistText}) until it is fixed.`,
      })
      return []
    }) as z.ZodType
}

/**
 * Official `Ko`: build the strict policy schema over `SettingsSchema().shape`.
 * Every field survives or fails closed individually — one invalid nested value
 * never discards the whole document, and mistyped locks apply their
 * restrictive value with a record naming the key.
 */
export function buildStrictPolicySchema(onIssue: PolicyIssueCallback): z.ZodType {
  const shape = SettingsSchema().shape as Record<string, z.ZodType>
  const wrapped: Record<string, z.ZodType> = {}

  // 1. Generic per-field catch: an invalid field is ignored, the rest of the
  //    document still applies (2.1.282 bullet b at the top level).
  for (const [key, field] of Object.entries(shape)) {
    wrapped[key] = (field as z.ZodType<unknown>).catch(ctx => {
      onIssue({
        path: key,
        message: `${firstIssueMessage(ctx as PolicyCatchContext, 'Failed schema validation')}. This field was ignored.`,
      })
      return undefined
    }) as z.ZodType
  }

  // 2. prepend/appendPlugins guarded variant (keys absent in OCC today).
  for (const key of ['prependPlugins', 'appendPlugins']) {
    if (key in shape) {
      wrapped[key] = z
        .array(z.string())
        .optional()
        .catch(ctx => {
          onIssue({
            path: key,
            message: `${firstIssueMessage(ctx as PolicyCatchContext, 'Failed schema validation')}. This field was ignored; read as unset.`,
          })
          return undefined
        }) as z.ZodType
    }
  }

  // 3. wslInheritsWindowsSettings bespoke wrapper (key absent in OCC today;
  //    official assigns unconditionally because the key exists there).
  if ('wslInheritsWindowsSettings' in shape) {
    wrapped.wslInheritsWindowsSettings = z
      .union([
        z.null().transform(() => undefined),
        z.preprocess(value => {
          const coerced = coerceStringBoolean(value)
          if (coerced !== value) {
            onIssue({
              path: 'wslInheritsWindowsSettings',
              message: `"wslInheritsWindowsSettings" holds the string "${String(coerced)}" where a boolean belongs; reading it as ${String(coerced)}. Write it without quotes.`,
              statusOnly: true,
            })
          }
          return coerced
        }, shape.wslInheritsWindowsSettings!),
      ])
      .optional()
      .catch(() => {
        onIssue({
          path: 'wslInheritsWindowsSettings',
          message: `"wslInheritsWindowsSettings" was present but invalid (it takes true or false), so this source's WSL opt-in cannot be read until it is fixed. WSL fails it closed: in an administrator source it arms the Windows policy chain with no user-writable source (/etc/claude-code, HKCU) read beneath it; in HKCU it leaves HKCU unapplied.`,
        })
        return undefined
      }) as z.ZodType
  }

  // 4. Marketplace policy arrays (`bi`) — whole-value fail-closed catches.
  if ('strictKnownMarketplaces' in shape) {
    wrapped.strictKnownMarketplaces = marketplaceArraySchema(
      'strictKnownMarketplaces',
      onIssue,
    ).catch(() => {
      onIssue({
        path: 'strictKnownMarketplaces',
        message:
          '"strictKnownMarketplaces" was present but invalid; enforcing an empty allowlist (no marketplaces admitted) until it is fixed.',
      })
      return []
    }) as z.ZodType
  }
  if ('blockedMarketplaces' in shape) {
    wrapped.blockedMarketplaces = marketplaceArraySchema(
      'blockedMarketplaces',
      onIssue,
    ).catch(() => {
      onIssue({
        path: 'blockedMarketplaces',
        message:
          '"blockedMarketplaces" was present but invalid and was dropped; its entries cannot be enforced until it is fixed.',
      })
      return undefined
    }) as z.ZodType
  }

  // 5. MCP allow/deny lists (`Ei`) — per-entry salvage + fail-closed catches.
  if ('allowedMcpServers' in shape) {
    wrapped.allowedMcpServers = salvagedEntryArraySchema(
      'allowedMcpServers',
      AllowedMcpServerEntrySchema(),
      onIssue,
    ).catch(() => {
      onIssue({
        path: 'allowedMcpServers',
        message:
          '"allowedMcpServers" was present but invalid; enforcing an empty allowlist (no MCP servers admitted) until it is fixed.',
      })
      return []
    }) as z.ZodType
  }
  if ('deniedMcpServers' in shape) {
    wrapped.deniedMcpServers = salvagedEntryArraySchema(
      'deniedMcpServers',
      DeniedMcpServerEntrySchema(),
      onIssue,
    ).catch(() => {
      onIssue({
        path: 'deniedMcpServers',
        message:
          '"deniedMcpServers" was present but invalid and was dropped; its entries cannot be enforced until it is fixed.',
      })
      return undefined
    }) as z.ZodType
  }

  // 6. Lock fields (`Ni` loop): string-boolean coercion, disable-false →
  //    absent, invalid → restrictive substitution (2.1.282 bullet a).
  const substitutedKeys = new Set<string>()
  for (const { key, restrictive, field } of collectLockFields(shape)) {
    const fallbackText =
      typeof restrictive === 'string' ? `"${restrictive}"` : String(restrictive)
    const coerced = z.preprocess(value => {
      if (typeof restrictive === 'boolean') {
        const result = coerceStringBoolean(value)
        if (result !== value) {
          onIssue({
            path: key,
            message: `"${key}" holds the string "${String(result)}" where a boolean belongs; reading it as ${String(result)}. Write it without quotes.`,
            statusOnly: true,
          })
        }
        return result
      }
      if (restrictive === 'disable' && (value === false || value === 'false')) {
        onIssue({
          path: key,
          message: `"${key}" was set to false; reading it as absent (the key's only value is "disable"). Remove the key instead.`,
          statusOnly: true,
        })
        return undefined
      }
      return value
    }, field)
    wrapped[key] = z
      .union([z.null().transform(() => undefined), coerced])
      .optional()
      .catch(() => {
        onIssue({
          path: key,
          message: `"${key}" was present but invalid; treating it as ${fallbackText} (its restrictive value) until it is fixed.`,
          substituted: true,
        })
        substitutedKeys.add(key)
        return restrictive
      }) as z.ZodType
  }

  // strictPluginOnlyCustomization bespoke wrapper (`Mi` @194713539):
  // unknown surface entries are filtered with a statusOnly typo warning;
  // a wholly invalid value locks EVERYTHING (true), never nothing.
  if ('strictPluginOnlyCustomization' in shape) {
    wrapped.strictPluginOnlyCustomization = z
      .union([
        z.null().transform(() => undefined),
        z.preprocess(value => {
          if (!Array.isArray(value)) return value
          const known = value.filter(entry =>
            (CUSTOMIZATION_SURFACES as readonly string[]).includes(entry),
          )
          if (known.length < value.length) {
            const dropped = value.length - known.length
            onIssue({
              path: 'strictPluginOnlyCustomization',
              message: `"strictPluginOnlyCustomization" lists ${dropped} ${plural(dropped, 'entry', 'entries')} this version does not recognize as a surface (known: ${CUSTOMIZATION_SURFACES.join(', ')}); an unrecognized entry locks nothing, so check it for a typo.`,
              statusOnly: true,
            })
          }
          return known
        }, z.union([z.boolean(), z.array(z.enum(CUSTOMIZATION_SURFACES))])),
      ])
      .optional()
      .catch(() => {
        onIssue({
          path: 'strictPluginOnlyCustomization',
          message:
            '"strictPluginOnlyCustomization" was present but invalid; treating it as true (skills, agents, hooks and MCP servers load from managed settings and plugins only) until it is fixed.',
          substituted: true,
        })
        substitutedKeys.add('strictPluginOnlyCustomization')
        return true
      }) as z.ZodType
  }

  // 7. enabledPlugins whole-map fail-closed catch (per-entry salvage staged).
  if ('enabledPlugins' in shape) {
    wrapped.enabledPlugins = (shape.enabledPlugins as z.ZodType<unknown>).catch(
      () => {
        onIssue({
          path: 'enabledPlugins',
          message:
            '"enabledPlugins" was present but invalid (not a map of plugin ids) and was ignored; no plugin is force-enabled or blocked by it until it is fixed.',
        })
        return undefined
      },
    ) as z.ZodType
  }

  // availableModels: non-string entries dropped individually; a wholly
  // invalid value enforces an EMPTY allowlist (only the default model).
  if ('availableModels' in shape) {
    wrapped.availableModels = z
      .array(z.any())
      .transform((entries: unknown[]) => {
        const kept: string[] = []
        for (const entry of entries) {
          if (typeof entry === 'string') kept.push(entry)
          else {
            onIssue({
              path: 'availableModels',
              message: `"availableModels" contained a non-string entry (${JSON.stringify(entry)}); the entry was ignored.`,
            })
          }
        }
        return kept
      })
      .optional()
      .catch(() => {
        onIssue({
          path: 'availableModels',
          message:
            '"availableModels" was present but invalid; enforcing an empty allowlist (only the default model is available) until it is fixed.',
        })
        return []
      }) as z.ZodType
  }

  // vo-backed fail-closed allowlists.
  if ('allowedHttpHookUrls' in shape) {
    wrapped.allowedHttpHookUrls = failClosedAllowlistSchema(
      'allowedHttpHookUrls',
      z.string(),
      onIssue,
      'no HTTP hooks may run',
    )
  }
  if ('httpHookAllowedEnvVars' in shape) {
    wrapped.httpHookAllowedEnvVars = failClosedAllowlistSchema(
      'httpHookAllowedEnvVars',
      z.string(),
      onIssue,
      'no environment variables may be interpolated into HTTP hook headers',
    )
  }
  if ('allowedChannelPlugins' in shape) {
    wrapped.allowedChannelPlugins = failClosedAllowlistSchema(
      'allowedChannelPlugins',
      z.object({ marketplace: z.string(), plugin: z.string() }),
      onIssue,
      'no channel plugins admitted',
    )
  }
  if ('gatewayInternalNetworks' in shape) {
    wrapped.gatewayInternalNetworks = z
      .array(z.string())
      .optional()
      .catch(() => {
        onIssue({
          path: 'gatewayInternalNetworks',
          message:
            '"gatewayInternalNetworks" was present but invalid; gateway sign-in governed by this source is refused until it is fixed.',
        })
        return [GATEWAY_UNREADABLE_SENTINEL]
      }) as z.ZodType
  }
  if ('forceLoginOrgUUID' in shape) {
    // Official substitutes [] — a truthy value no organization UUID can match,
    // i.e. no organization is permitted to log in until the field is fixed.
    wrapped.forceLoginOrgUUID = (shape.forceLoginOrgUUID as z.ZodType<unknown>).catch(
      () => {
        onIssue({
          path: 'forceLoginOrgUUID',
          message:
            '"forceLoginOrgUUID" was present but invalid; no organization is permitted to log in until it is fixed.',
        })
        return [] as unknown as undefined
      },
    ) as z.ZodType
  }

  // 8. Per-block salvage rebuild (`Ki`): permissions / autoMode / worktree /
  //    attribution — one invalid nested value no longer discards the block
  //    (2.1.282 bullet b).
  const synthesized = new WeakSet<object>()
  for (const [key, field] of Object.entries(shape)) {
    if (!isRebuiltBlock(key)) continue
    const inner = unwrapToObjectSchema(field)
    if (inner !== undefined) {
      wrapped[key] = rebuildBlockSchema(key, inner, onIssue, {
        synthesized,
        strictField: field,
      })
    }
  }

  // 9. Tail: drop undefined values, then flag sources whose ONLY applicable
  //    content is fail-closed substitutions (onlySubstitutes).
  return z
    .object(wrapped as Record<string, z.ZodTypeAny>)
    .passthrough()
    .transform((value: Record<string, unknown>) => {
      const defined = Object.fromEntries(
        Object.entries(value).filter(([, v]) => v !== undefined),
      )
      const applicable = Object.keys(defined).filter(
        key => !TAIL_EXCLUDED_KEYS.some(excluded => excluded === key),
      )
      const onlySubstitutes =
        applicable.length > 0 &&
        applicable.every(
          key =>
            substitutedKeys.has(key) ||
            isSynthesizedObject(synthesized, defined[key]),
        )
      substitutedKeys.clear()
      if (onlySubstitutes) {
        for (const key of applicable) {
          onIssue({
            path: key,
            message: `"${key}" holds nothing that could be applied as written and is this source's only policy content; its fail-closed reading binds (beside a lower managed settings source's policy, when one supplies it) until it is fixed.`,
            statusOnly: true,
            onlySubstitutes: true,
          })
        }
      }
      return defined
    }) as z.ZodType
}

/**
 * Official `pd`: issue sink — appends a warning-severity ValidationError per
 * issue and echoes statusOnly/startupFatal records to the debug log. The
 * official `RAe` filter (managedMcpServers paths) is skipped: the key is
 * absent from the OCC schema. The official logs with level warn/error; OCC's
 * logForDebugging has no level parameter.
 */
export function createPolicyIssueSink(
  file: string,
  errors: ValidationError[],
): PolicyIssueCallback {
  return issue => {
    errors.push({
      file,
      path: issue.path,
      message: issue.message,
      severity: 'warning',
      ...(issue.statusOnly && { statusOnly: issue.statusOnly }),
      ...(issue.startupFatal && { startupFatal: issue.startupFatal }),
      ...(issue.substituted && { substituted: issue.substituted }),
      ...(issue.onlySubstitutes && { onlySubstitutes: issue.onlySubstitutes }),
    })
    if (issue.statusOnly || issue.startupFatal) {
      logForDebugging(`${file}: ${issue.path}: ${issue.message}`)
    }
  }
}

/**
 * Official `jdn`: record for a managed-settings document that is not a JSON
 * object at all. The default variant blocks startup (OS-admin sources); the
 * userWritable variant (HKCU) is a status-only warning.
 */
export function managedDocNotObjectRecord(
  file: string,
  options: { userWritable?: boolean } = {},
): ValidationError {
  if (options.userWritable) {
    return {
      file,
      path: '',
      message: `Managed settings document (${file}) could not be parsed as a JSON object; none of its settings are in effect. Fix or remove it.`,
      severity: 'warning',
      statusOnly: true,
      userWritable: true,
    }
  }
  return {
    file,
    path: '',
    message:
      'Managed settings document could not be parsed as a JSON object; none of its settings are in effect. Fix or remove it.',
    startupFatal: true,
  }
}

/** Re-exported for the wiring sites (official `V`/`Ea` check). */
export { isPlainObject, hasNestedRestriction }
