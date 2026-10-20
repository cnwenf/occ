/**
 * CC 2.1.304 changelog #6 — the compaction summary carries the names of tools
 * called earlier in the conversation, inside a `<tools-used-before-summary>`
 * XML tag. The model sees the raw tag; the human transcript view (Ctrl+O)
 * rewrites it to a readable "Tools called before this summary: …" line.
 *
 * Everything here is byte-verified from the official 2.1.304 linux-x64 ELF
 * (offsets in docs/gap-research-304/research-R3-session-api.md §#6):
 *   dve="tools-used-before-summary" (@247678644)
 *   HJ  @247678820  = getToolNamesUsed       (extractor)
 *   Zan @247679308  = renderToolsUsedBeforeSummary (tag renderer)
 *   jEs @247679378  = stripToolsUsedTagForTranscript (transcript-view rewrite)
 *   Mir @247678660  = VALID_TOOL_NAME_RE     (name filter)
 *   Xan @247678676  = TOOLS_USED_TAG_RE      (prior-tag match)
 *   Ma              = escapeRegExp           (src/utils/stringUtils.ts)
 *   ac(e)=w2o(MWr,e) (@236587529) = alias-normalize — see DEVIATION below.
 *
 * DEVIATION (documented): the official `HJ` normalizes each tool name through
 * the global alias map `ac`/`MWr`. OCC has NO global tool-name alias map (only
 * per-tool `aliases?: string[]` in Tool.ts), so this port keeps the raw trimmed
 * name (`ac(x)` → `x`). Behavior is identical for every first-party tool name
 * (they carry no aliases in the map); only a hypothetical alias spelling would
 * differ, and OCC never emits aliased tool names into transcripts.
 *
 * ADAPTATION (documented): the official `Xan` is built with two optional
 * `Van=(?:${Dh}\n.*\n)?` prefix groups wrapping the header (`eXe`) — those
 * carry the unrecovered `foreignArtifact` preamble (`Uy`). OCC summaries have
 * no foreignArtifact, so the adapted regex drops the `Van` groups and anchors
 * directly on OCC's own header (summaryHeader.ts COMPACT_SUMMARY_HEADER),
 * keeping group1 = header prefix and group2 = the comma-joined names — the
 * exact capture-group contract both `HJ` (`?.[2]`) and `jEs` (`(n,r,s)=>…`)
 * rely on.
 */
import type { ContentBlock, ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { escapeRegExp } from '../../utils/stringUtils.js'
import { COMPACT_SUMMARY_HEADER } from './summaryHeader.js'

/** Official `dve` (byte-verified @247678644) — the summary tag name. */
export const TOOLS_USED_BEFORE_SUMMARY_TAG = 'tools-used-before-summary'

/**
 * Official `Mir` (byte-verified @247678660):
 *   `/^(?!.*\s{2})[^<>,\p{C}  ]{1,256}$/u`
 * A valid tool name: no double-whitespace anywhere, no `<`/`>`/`,`, no control
 * chars (`\p{C}`) and no line/paragraph separators (U+2028/U+2029), 1-256 chars.
 * The U+2028/U+2029 escapes are literal in the official char class (confirmed
 * via hexdump: `e2 80 a8` / `e2 80 a9`) — written escaped here so the source
 * stays editor-safe and byte-faithful.
 */
export const VALID_TOOL_NAME_RE =
  /^(?!.*\s{2})[^<>,\p{C}\u2028\u2029]{1,256}$/u

/**
 * Official `Xan` (adapted — see the ADAPTATION note in the file header).
 * group1 = the header prefix (`header\n\n`), group2 = the comma-joined names
 * inside the tag. `\n?` optionally consumes the tag's trailing newline so the
 * transcript rewrite leaves clean spacing.
 */
export const TOOLS_USED_TAG_RE = new RegExp(
  `^(${escapeRegExp(COMPACT_SUMMARY_HEADER)}\\n\\n)<${TOOLS_USED_BEFORE_SUMMARY_TAG}>([^<]*)</${TOOLS_USED_BEFORE_SUMMARY_TAG}>\\n?`,
)

/** A content block, loosely typed for the extractor's `.type`/`.name`/`.text` reads. */
type LooseBlock = {
  type?: string
  name?: unknown
  text?: unknown
}

/** The minimal message shape the official `HJ` reads (OCC `Message` satisfies it). */
type MessageLike = {
  type?: string
  isCompactSummary?: boolean
  message?: { content?: unknown }
}

/**
 * Official `Zan` (byte-verified @247679308):
 *   `function Zan(e=[]){return `<${dve}>${e.join(", ")}</${dve}>\n`}`
 * The default `[]` means the tag is ALWAYS rendered — an empty
 * `<tools-used-before-summary></tools-used-before-summary>\n` when no names
 * were collected. `jEs` hides the empty tag in transcript view (group2 falsy
 * → prefix only), so the model still sees the (empty) tag exactly as official.
 */
export function renderToolsUsedBeforeSummary(
  toolNamesUsed: string[] = [],
): string {
  return `<${TOOLS_USED_BEFORE_SUMMARY_TAG}>${toolNamesUsed.join(', ')}</${TOOLS_USED_BEFORE_SUMMARY_TAG}>\n`
}

/**
 * Official `HJ` (byte-verified @247678820) — collect the set of tool names
 * used across the conversation:
 *   `function HJ(e){let n=new Set;for(let r of e){
 *      if(r.type!=="user"&&r.type!=="assistant")continue;
 *      let s=r.message?.content,h=Array.isArray(s)?s:[{type:"text",text:s}];
 *      for(let y of h)
 *        if((y?.type==="tool_use"||y?.type==="server_tool_use")&&typeof y.name==="string")
 *          n.add(ac(y.name.trim()));
 *        else if(r.type==="user"&&r.isCompactSummary&&y?.type==="text"&&typeof y.text==="string")
 *          (y.text.match(Xan)?.[2]??"").split(",").forEach((w)=>n.add(w.trim()))
 *    }return [...n].filter((r)=>Mir.test(r)).sort()}`
 * `ac(...)` alias-normalize is dropped (see DEVIATION) — the trimmed name is
 * added directly. Prior summaries' names are carried forward by matching the
 * `<tools-used-before-summary>` tag in a compact-summary user message.
 */
export function getToolNamesUsed(messages: readonly MessageLike[]): string[] {
  const names = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') {
      continue
    }
    const content = msg.message?.content
    const blocks: LooseBlock[] = Array.isArray(content)
      ? (content as Array<ContentBlock | ContentBlockParam>)
      : [{ type: 'text', text: content as string | undefined }]
    for (const block of blocks) {
      if (
        (block?.type === 'tool_use' || block?.type === 'server_tool_use') &&
        typeof block.name === 'string'
      ) {
        names.add(block.name.trim())
      } else if (
        msg.type === 'user' &&
        msg.isCompactSummary &&
        block?.type === 'text' &&
        typeof block.text === 'string'
      ) {
        const prior = block.text.match(TOOLS_USED_TAG_RE)?.[2] ?? ''
        for (const carried of prior.split(',')) {
          names.add(carried.trim())
        }
      }
    }
  }
  return [...names].filter(name => VALID_TOOL_NAME_RE.test(name)).sort()
}

/**
 * Official `jEs` (byte-verified @247679378):
 *   `function jEs(e){return e.replace(Xan,(n,r,s)=>s?`${r}Tools called before this summary: ${s}\n`:r)}`
 * In the transcript view the tag becomes a readable line; an empty tag (no
 * names) collapses to just the header prefix so nothing extra shows. The model
 * still receives the raw XML tag — this transform is display-only.
 */
export function stripToolsUsedTagForTranscript(text: string): string {
  return text.replace(
    TOOLS_USED_TAG_RE,
    (_match, prefix: string, names: string) =>
      names ? `${prefix}Tools called before this summary: ${names}\n` : prefix,
  )
}
