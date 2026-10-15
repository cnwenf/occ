import { APIError } from '@anthropic-ai/sdk'
import { isDeepStrictEqual } from 'util'
import { logForDebugging } from '../../utils/debug.js'
import { hashContent } from '../../utils/hash.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { extractRefusedToolSchemaIndex } from './errorUtils.js'

/**
 * CC 2.1.300 (#36): "Fixed a conversation failing on every turn with a 400
 * error when the API rejected an MCP tool's input schema; Claude Code now
 * sends that tool without parameters for the rest of the conversation."
 *
 * Official v300 `AGe` module @225850721 (byte-verified):
 *
 *   import{isDeepStrictEqual as aFo}from"util";var lFo=8,U1t={type:"object"};
 *   function j1t(e){return at($i(e))}   // canonical hash of the input_schema
 *   function W1t(e,n){let r=n.refusedToolSchemas;if(r.size===0)return e;
 *     try{return e.map((s)=>{if(!("input_schema"in s)||!r.has(s.name)||
 *       r.get(s.name)!==j1t(s.input_schema))return s;
 *       let{eager_input_streaming:h,...y}=s;
 *       return{...y,input_schema:{...U1t}}})}catch(s){return l(F(s)),e}}
 *   class AGe{#e;#t=0;constructor(e){this.#e=e}resolve(e,n,r,s){…}}
 *
 * with the MCP gate `Kg` @222761037:
 *   function Kg(e){return e.name?.startsWith("mcp__")||e.isMcp===!0}
 *
 * Scope mapping (documented deviation): the official keeps
 * `refusedToolSchemas` on the conversation-scoped sticky-betas context
 * (`Gte()`'s `st`, cleared by `w3n` on transcript_cleared/@clear
 * @239179269). OCC has no equivalent context object inside this run's file
 * cluster, so the map lives at module level — in OCC's per-process
 * conversation model that is the same lifetime. `clearRefusedToolSchemas()`
 * is exported for the /clear wiring (call site outside this cluster).
 */

/** Official `lFo` = 8 — max schema replacements per resolver (per request). */
export const TOOL_SCHEMA_REFUSED_CAP = 8

/** Official `U1t` = {type:"object"} — the flattened schema sent instead. */
export const EMPTY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
}

/** Official retry token @240729/@107537948: `retry:tool-schema-refused-N`. */
export const TOOL_SCHEMA_REFUSED_RETRY_TOKEN_PREFIX =
  'retry:tool-schema-refused-'

/** GrowthBook gate in the official resolve: `k("tengu_calm_crescent",!0)`. */
const CALM_CRESCENT_FLAG = 'tengu_calm_crescent'

/** Official skip/replacement reasons (AGe.#o / resolve telemetry). */
type SkipReason =
  | 'switched_off'
  | 'no_mcp_tool_at_index'
  | 'already_replaced'
  | 'bound_reached'

/** A tool entry as serialized for the API (BetaTool union member). */
export interface SentToolSchemaEntry {
  name?: unknown
  input_schema?: unknown
  eager_input_streaming?: unknown
  [key: string]: unknown
}

/** Registry-side facts the resolver needs (official `un(r,name)` result). */
export interface SchemaRefusalRegistryTool {
  isMcp?: boolean
  mcpInfo?: { serverName: string; toolName: string }
}

export type SchemaRefusalToolLookup = (
  name: string,
) => SchemaRefusalRegistryTool | undefined

export interface ToolSchemaRefusedResolver {
  /**
   * Official `AGe.resolve(error, sentTools, registry, querySource)`: returns
   * the retry token when a refusal was recorded (caller must retry), or
   * undefined when the 400 is unrelated / the heal declined.
   */
  resolve(
    error: unknown,
    sentTools: readonly SentToolSchemaEntry[] | undefined,
    findTool: SchemaRefusalToolLookup | undefined,
    querySource?: string,
  ): string | undefined
  /** Official `AGe.served()` — end-of-request aggregate telemetry. */
  served(): void
}

// Conversation-scoped state (official `st.refusedToolSchemas`, created in
// `Gte()` as `refusedToolSchemas:new Map`).
const refusedToolSchemas = new Map<string, string>()

// Official `Oo(serverName, note)` MCP-server note channel. OCC has no
// per-server notice surface in this cluster; the notes are recorded here
// (latest per server, matching Oo's overwrite semantics) and logged.
const mcpSchemaRefusalNotes = new Map<string, string>()

/** Official `$i` — canonical (key-sorted) JSON stringify for stable hashes. */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map(key => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    .join(',')}}`
}

/** Official `j1t(e){return at($i(e))}` — canonical hash of an input_schema. */
export function hashInputSchema(schema: unknown): string {
  return hashContent(canonicalStringify(schema))
}

/**
 * Official `Kg` @222761037: `e.name?.startsWith("mcp__")||e.isMcp===!0`.
 */
export function isMcpToolRefForSchemaRefusal(ref: {
  name?: unknown
  isMcp?: boolean
}): boolean {
  return (
    (typeof ref.name === 'string' && ref.name.startsWith('mcp__')) ||
    ref.isMcp === true
  )
}

/**
 * Official `W1t` — the params-builder substitution (@227858355:
 * `gd=W1t(gd,st)`). Tools whose recorded schema hash still matches go out
 * with `{type:"object"}` (a fresh copy, matching `{...U1t}`) and without
 * `eager_input_streaming`; everything else is returned untouched. When the
 * map is empty the original array reference is returned (official
 * `if(r.size===0)return e`), and any internal error falls back to the
 * original array (official try/catch).
 */
export function applyRefusedToolSchemas<T extends SentToolSchemaEntry>(
  tools: T[],
): T[] {
  if (refusedToolSchemas.size === 0) {
    return tools
  }
  try {
    return tools.map(tool => {
      if (
        !('input_schema' in tool) ||
        typeof tool.name !== 'string' ||
        !refusedToolSchemas.has(tool.name) ||
        refusedToolSchemas.get(tool.name) !== hashInputSchema(tool.input_schema)
      ) {
        return tool
      }
      const { eager_input_streaming: _omitted, ...rest } = tool
      return { ...rest, input_schema: { ...EMPTY_INPUT_SCHEMA } } as T
    })
  } catch (err) {
    logForDebugging(
      `[tool-schema] applyRefusedToolSchemas failed, sending tools unchanged: ${String(err)}`,
      { level: 'error' },
    )
    return tools
  }
}

/**
 * Official `w3n(e){e.refusedToolSchemas.clear()}` (@239179269, called on
 * transcript_cleared // /clear). Exported for the clear-path wiring; also
 * used by tests to reset the conversation-scoped state.
 */
export function clearRefusedToolSchemas(): void {
  refusedToolSchemas.clear()
  mcpSchemaRefusalNotes.clear()
}

/** The MCP-server notes recorded so far (official `Oo(serverName, note)`). */
export function getMcpSchemaRefusalNotes(): ReadonlyMap<string, string> {
  return mcpSchemaRefusalNotes
}

/**
 * Official `new AGe(st)` (@227866518) — created once per request; `#t`
 * (replacement counter, capped at `lFo`=8) is per resolver instance while
 * the refusal map is conversation-scoped.
 */
export function createToolSchemaRefusedResolver(): ToolSchemaRefusedResolver {
  let replacements = 0

  const telemetryBase = (querySource?: string) => ({
    replacements,
    query_source: (querySource ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  const skip = (reason: SkipReason, querySource?: string): undefined => {
    logEvent('tengu_api_tool_schema_replacement', {
      action:
        reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...telemetryBase(querySource),
    })
    return undefined
  }

  return {
    resolve(error, sentTools, findTool, querySource) {
      try {
        // Official: `if(!(e instanceof Rt)||e.status!==400)return` + the
        // regex scan (both mirrored by extractRefusedToolSchemaIndex).
        if (!(error instanceof APIError) || error.status !== 400) {
          return undefined
        }
        const rawIndex = extractRefusedToolSchemaIndex(error)
        if (rawIndex === undefined) {
          return undefined
        }
        // Official: `if(!k("tengu_calm_crescent",!0))return this.#o("switched_off",s)`
        if (
          !getFeatureValue_CACHED_MAY_BE_STALE<boolean>(CALM_CRESCENT_FLAG, true)
        ) {
          return skip('switched_off', querySource)
        }
        const tool = sentTools?.[rawIndex]
        if (
          tool === undefined ||
          typeof tool !== 'object' ||
          tool === null ||
          !('input_schema' in tool)
        ) {
          return skip('no_mcp_tool_at_index', querySource)
        }
        const name = tool.name
        // Official: `let S=un(r,y.name); if(!Kg({name:y.name,isMcp:S?.isMcp}))`
        const registryTool =
          typeof name === 'string' ? findTool?.(name) : undefined
        if (
          typeof name !== 'string' ||
          !isMcpToolRefForSchemaRefusal({ name, isMcp: registryTool?.isMcp })
        ) {
          return skip('no_mcp_tool_at_index', querySource)
        }
        // Official: `if(aFo(y.input_schema,U1t))return this.#o("already_replaced",s)`
        if (isDeepStrictEqual(tool.input_schema, EMPTY_INPUT_SCHEMA)) {
          return skip('already_replaced', querySource)
        }
        // Official: `if(this.#t>=lFo)return this.#o("bound_reached",s)`
        if (replacements >= TOOL_SCHEMA_REFUSED_CAP) {
          return skip('bound_reached', querySource)
        }
        // Official: record, count, telemetry, MCP-server note, retry token.
        refusedToolSchemas.set(name, hashInputSchema(tool.input_schema))
        replacements++
        logEvent('tengu_api_tool_schema_replacement', {
          action:
            'replaced' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ...telemetryBase(querySource),
        })
        if (registryTool?.mcpInfo) {
          // Official note string @107537731/@225851872 (byte-verified).
          const note = `Tool "${registryTool.mcpInfo.toolName}": the API refused this tool's input schema. Claude can still call the tool in this conversation, but does not see its parameters. Fix the schema on the MCP server, then start a new conversation. The API said: ${error.message}`
          mcpSchemaRefusalNotes.set(registryTool.mcpInfo.serverName, note)
          logForDebugging(`[mcp] ${note}`, { level: 'warn' })
        }
        return `${TOOL_SCHEMA_REFUSED_RETRY_TOKEN_PREFIX}${replacements}`
      } catch (err) {
        // Official resolve wrapper @227866518: `catch(Jo){l(F(Jo));return}`.
        logForDebugging(
          `[tool-schema] refused-schema resolver threw: ${String(err)}`,
          { level: 'error' },
        )
        return undefined
      }
    },
    served() {
      // Official: `if(this.#t>0)g("api_tool_schema_replacement",{replacements:this.#t})`
      if (replacements > 0) {
        logEvent('tengu_api_tool_schema_replacement_served', { replacements })
      }
    },
  }
}
