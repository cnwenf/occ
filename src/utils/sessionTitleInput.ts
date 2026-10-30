import {
  BASH_INPUT_TAG,
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
} from '../constants/xml.js'
import type { Message } from '../types/message.js'
import { escapeRegExp } from './stringUtils.js'
import { firstLine, truncateText } from './textTruncate.js'

/**
 * CC 2.1.314 items 61 + 78 — the official session-title input module (v314
 * binary @261917800..261927300, exports `{pRo,GFs,zMr,uzn,fzn,pzn,zFs,KFs,
 * mzn,nin,Uht}`; the whole module is NEW in v314 per the v312→v314
 * added-strings diff).
 *
 * Item 78: "Improved session auto-titles: a session that starts with a skill
 * or a prompt-based command such as /security-review now gets a title from it
 * instead of staying untitled." — `titleInputFromMessage` (official `zMr`)
 * derives title input from `<command-message>` breadcrumbs or raw
 * `/name args` input for known prompt-type commands.
 *
 * Item 61: "Fixed sessions staying untitled when the first prompt failed
 * (for example on a usage limit) and the conversation continued afterward."
 * — `makeTitleFallback`/`reduceTitleFallback` (official `fzn`/`pzn`) keep a
 * fallback {text, unusableRepliesLeft} so a failed/unusable title request is
 * retried on a later turn with the ORIGINAL prose, and
 * `isUsageLimitContinuationText` (official `uBs`) recognizes the usage-limit
 * auto-resume prompts so they never become the title prose.
 *
 * Official minified-name map (all byte-verified in the v314 binary):
 *   T=1000 (conversation cap, lives in sessionTitle.ts), S=10, y=200, b=2,
 *   _ =isMeaningfulTitleText, zMr=titleInputFromMessage,
 *   uzn=titleInputFromQueuedMessage, fzn=makeTitleFallback,
 *   pzn=reduceTitleFallback, KFs=firstTitleEligibleMessage, Bme predicate,
 *   em=contentToText, iN=lastTextBlockContent, BE=startsWithSlashCommand,
 *   ci=extractTagContent @253061957, Vo=escapeRegExp @243461364,
 *   l7n=startsAsKnownCommand, yX=parseSlashCommand, Js/Bbe=findTitleCommand,
 *   VR alias matcher @251629816, Xhn=isSensitiveTitleInput @251632xxx,
 *   URe=isSensitiveCommandArgs @251630317, M4/_C=isNonProseBreadcrumb
 *   @245850515, $l=isHumanOrigin @247231046, Lg=isHumanOrUndefinedOrigin
 *   @247236805, pr/Ze=firstLine @243464345/243463911, ne=truncateText,
 *   uBs=isUsageLimitContinuationText @260339345.
 */

// ---------------------------------------------------------------------------
// Constants (official `var T=1000,S=10,y=200` @261917800 region, `var b=2`
// @261919165)
// ---------------------------------------------------------------------------

/** Official `S=10` — minimum trimmed length of usable title prose. */
export const MIN_TITLE_INPUT_LENGTH = 10

/** Official `y=200` — command-description line truncation cap. */
export const TITLE_DESCRIPTION_MAX = 200

/** Official `b=2` — unusable replies tolerated before dropping a fallback. */
export const UNUSABLE_REPLIES_LEFT = 2

/**
 * Official `L` @260320000-region (byte-verified): usage-limit reset resume
 * prompt enqueued by the official usage-limit auto-continuation flow.
 */
export const USAGE_LIMIT_RESET_CONTINUATION_TEXT =
  'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.'

/**
 * Official `E` @260320000-region (byte-verified): early "usage available
 * again" resume prompt.
 */
export const USAGE_AVAILABLE_CONTINUATION_TEXT =
  'Your claude.ai usage is available again before the usage-limit reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.'

/**
 * Official pill alternation `Pc` @251629584:
 * ``String.raw`Pasted text|Image|\.\.\.Truncated text|${xVe}` `` where
 * `xVe="✦ Team setup guide"`. OCC has no Team-setup-guide pill (no team
 * feature), so the alternation matches OCC's own pill set (history.ts
 * parseReferences uses the same three names).
 */
const PILL_NAMES_PATTERN = String.raw`Pasted text|Image|\.\.\.Truncated text`

/**
 * Official `qR` @251632xxx (byte-verified):
 * ``new RegExp(String.raw`^(\/[^\s[]+)\[(?=(?:${Pc}) #\d+)`)`` — matches a
 * `/command` immediately followed by a pill (`/cmd[Pasted text #1]…`) so the
 * sensitivity parse can space it out first (`s.replace(qR,"$1 [")`).
 */
const COMMAND_GLUED_PILL_RE = new RegExp(
  String.raw`^(\/[^\s[]+)\[(?=(?:${PILL_NAMES_PATTERN}) #\d+)`,
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structural subset of OCC's Command that the title gates read. */
export interface TitleCommand {
  name: string
  type: string
  aliases?: string[]
  userFacingName?: () => string
  description?: string
  menuDescription?: string
  userInvocable?: boolean
  isSensitive?: boolean | ((args: string) => boolean)
  isEnabled?: () => boolean
}

/** Official origin param (`$l`/`Lg` read `origin?.kind`). */
export interface TitleMessageOrigin {
  kind?: string
}

/** Content shapes accepted by official `em`/`BE`/`iN`. */
export type TitleContentInput = unknown

/** Official fallback state (fzn/pzn `r` param, QueryEngine `_titleFallback`). */
export interface TitleFallback {
  text: string
  unusableRepliesLeft: number
}

/** Official `nin` result kinds (see sessionTitle.ts requestSessionTitle). */
export type SessionTitleRequestResult =
  | { kind: 'titled'; title: string }
  | { kind: 'unusable' }
  | { kind: 'failed' }

// ---------------------------------------------------------------------------
// Small predicates / helpers
// ---------------------------------------------------------------------------

/** Official `_(e){return e.trim().length>=S}` @261917800 region. */
export function isMeaningfulTitleText(text: string): boolean {
  return text.trim().length >= MIN_TITLE_INPUT_LENGTH
}

/** Official `$l(e){return e?.kind==="human"}` @247231046. */
export function isHumanOrigin(origin: TitleMessageOrigin | undefined): boolean {
  return origin?.kind === 'human'
}

/** Official `Lg(e){return e===void 0||e.kind==="human"}` @247236805. */
export function isHumanOrUndefinedOrigin(
  origin: TitleMessageOrigin | undefined,
): boolean {
  return origin === undefined || origin.kind === 'human'
}

/**
 * Official `em(e)` @258037519:
 * `if(typeof e==="string")return e; if(Array.isArray(e))return
 * qo(e,"\n").trim()||null; return null` (qo joins the text blocks with \n).
 */
export function contentToText(content: TitleContentInput): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const joined = content
      .map(block =>
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
          ? ((block as { text: string }).text)
          : '',
      )
      .filter(part => part !== '')
      .join('\n')
    return joined.trim() || null
  }
  return null
}

/**
 * Official `iN(e)` @251632018:
 * `if(typeof e==="string")return e; let n=e.at(-1); return
 * n?.type==="text"?n.text:null`.
 */
export function lastTextBlockContent(content: TitleContentInput): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const last = content.at(-1) as { type?: string; text?: string } | undefined
  return last?.type === 'text' ? (last.text ?? null) : null
}

/**
 * Official `BE(e)` @251629xxx:
 * `if(typeof e==="string")return e.trim().startsWith("/");
 *  if(!Array.isArray(e))return!1; let n=e.at(-1);
 *  return n?.type==="text"&&typeof n.text==="string"&&
 *  n.text.trim().startsWith("/")`.
 */
export function startsWithSlashCommand(content: TitleContentInput): boolean {
  if (typeof content === 'string') return content.trim().startsWith('/')
  if (!Array.isArray(content)) return false
  const last = content.at(-1) as { type?: string; text?: unknown } | undefined
  return (
    last?.type === 'text' &&
    typeof last.text === 'string' &&
    last.text.trim().startsWith('/')
  )
}

/**
 * Official `ci(n,e)` @253061957 (byte-verified) — `<tag>…</tag>` content
 * extractor. Scans (open, first-close-after-open) pairs; a pair is REJECTED
 * when an unmatched close tag ends before the open tag starts
 * (`u=i.index+i[0].length<=t.index`), and the scan continues from after the
 * pair's close. Returns the first non-empty accepted content. Note: for a
 * nested same-tag open the content runs to the FIRST close (the nested open
 * stays literal) — verified against a verbatim transcription of the official
 * function.
 */
export function extractTagContent(text: string, tag: string): string | null {
  if (!text.trim() || !tag.trim()) return null
  const escaped = escapeRegExp(tag)
  const openRe = new RegExp(`<${escaped}(?=[\\s>])`, 'gi')
  const closeRe = new RegExp(`<\\/${escaped}>`, 'gi')
  let cursor = 0
  for (;;) {
    openRe.lastIndex = cursor
    const open = openRe.exec(text)
    closeRe.lastIndex = cursor
    const close = closeRe.exec(text)
    if (!open || !close) return null
    const openEnd = text.indexOf('>', open.index + open[0].length)
    if (openEnd === -1) return null
    closeRe.lastIndex = openEnd + 1
    const innerClose = closeRe.exec(text)
    if (!innerClose) return null
    const closeBeforeOpen = close.index + close[0].length <= open.index
    const inner = text.slice(openEnd + 1, innerClose.index)
    if (inner && !closeBeforeOpen) return inner
    cursor = innerClose.index + innerClose[0].length
  }
}

/**
 * Official `yX(e)` @251628600 region (byte-verified):
 * `let n=e.startsWith("/")?e.slice(1):e, r=n.search(/\s/);
 *  if(r===-1)return{name:n,args:""};
 *  return{name:n.slice(0,r),args:n.slice(r+1).trim()}`.
 */
export function parseSlashCommand(input: string): { name: string; args: string } {
  const withoutSlash = input.startsWith('/') ? input.slice(1) : input
  const split = withoutSlash.search(/\s/)
  if (split === -1) return { name: withoutSlash, args: '' }
  return {
    name: withoutSlash.slice(0, split),
    args: withoutSlash.slice(split + 1).trim(),
  }
}

/**
 * Official `l7n(e,n)` @251628600 region (byte-verified): true when the input
 * starts with a known command name — either the `[a-zA-Z0-9:_-]+` prefix or
 * (when different) the first whitespace-delimited token resolves via `n`.
 */
export function startsAsKnownCommand(
  input: string,
  isKnownCommandName: (name: string) => boolean,
): boolean {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) return false
  const name = trimmed.slice(1).match(/^[a-zA-Z0-9:_-]+/)?.[0]
  const firstToken = trimmed.slice(1).split(/\s/, 1)[0]
  if (name !== undefined && isKnownCommandName(name)) return true
  return (
    firstToken !== undefined &&
    firstToken !== name &&
    firstToken.length > 0 &&
    isKnownCommandName(firstToken)
  )
}

/**
 * Official `Js(e,n)`/`VR(e,n)` @251629816/251629892 (byte-verified):
 * exact `name` match wins; else the first `VR` alias match
 * (`e.name===n||Xo(e)===n||aliases.includes(n)` — `Xo` ≡ OCC
 * `getCommandName` = `userFacingName?.() ?? name`); else a prompt command
 * whose `directoryListingName` matches. OCC's Command type has no
 * `directoryListingName` field, so the third branch has no OCC surface
 * (same matcher set as OCC's `findCommand` in commands.ts — duplicated here
 * to keep this module light for unit tests).
 */
export function findTitleCommand(
  name: string,
  commands: TitleCommand[],
): TitleCommand | undefined {
  let aliasMatch: TitleCommand | undefined
  for (const cmd of commands) {
    if (cmd.name === name) return cmd
    if (aliasMatch === undefined) {
      const userFacing = cmd.userFacingName?.() ?? cmd.name
      if (
        cmd.name === name ||
        userFacing === name ||
        (cmd.aliases?.includes(name) ?? false)
      ) {
        aliasMatch = cmd
      }
    }
  }
  return aliasMatch
}

/**
 * Official `Xhn(e,n,{pastedTexts:r=[]}={})` @251632xxx (byte-verified),
 * minus the `Ac` secret-pattern scan (official `Ac(e)` @251631885 runs the
 * `WIe` scanner over 65536-char windows — OCC has no port of that scanner;
 * the branches below that would call it return false instead. Divergence
 * direction: OCC may title a command text containing a secret where the
 * official would suppress the title. All zMr/uzn call sites pass no
 * pastedTexts, so the `r.some(Ac)` / `r.length>0&&YR.test(y)` branches are
 * dead there and are not ported.)
 */
export function isSensitiveTitleInput(
  input: string,
  commands: TitleCommand[],
): boolean {
  let s = input.trim()
  if (s.startsWith('!')) {
    s = s.slice(1).trimStart()
    // Official: `if(Ac(s))return!0` — secret scan (not ported, see above).
  }
  if (!s.startsWith('/')) return false
  const { name, args } = parseSlashCommand(
    s.replace(COMMAND_GLUED_PILL_RE, '$1 ['),
  )
  const cmd = findTitleCommand(name, commands)
  if (!cmd?.isSensitive) {
    // Official: `return Ac(s.slice(1))` — secret scan (not ported → false).
    return false
  }
  return isSensitiveCommandArgs(cmd, args)
}

/**
 * Official `URe(e,n)` @251630317 (byte-verified):
 * `if(n.trim()==="")return!1; let{isSensitive:r}=e;
 *  return typeof r==="function"?r(n):r===!0`.
 */
export function isSensitiveCommandArgs(
  cmd: TitleCommand,
  args: string,
): boolean {
  if (args.trim() === '') return false
  const { isSensitive } = cmd
  return typeof isSensitive === 'function' ? isSensitive(args) : isSensitive === true
}

/**
 * Official `M4(e)` @245850515 (byte-verified): non-prose breadcrumb texts
 * that must never become a title — local-command stdout/stderr, the
 * command-message/command-name pair (`_C`), bash-mode input/output, and task
 * notifications.
 */
export function isNonProseBreadcrumb(text: string): boolean {
  return (
    text.startsWith(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
    text.startsWith(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
    text.startsWith(`<${COMMAND_MESSAGE_TAG}>`) ||
    text.startsWith(`<${COMMAND_NAME_TAG}>`) ||
    text.startsWith(`<${BASH_INPUT_TAG}>`) ||
    text.startsWith(`<${BASH_STDOUT_TAG}>`) ||
    text.startsWith(`<${BASH_STDERR_TAG}>`) ||
    text.startsWith(`<${TASK_NOTIFICATION_TAG}>`)
  )
}

/**
 * Official `uBs(e)` @260339345 (byte-verified):
 * `return e===L||e===E||bHr()&&e.trim()===x().trim()`. The third disjunct is
 * the model-configured resume text behind `tengu_lantern_wick_resume_by_model`
 * (Statsig, default off, catch→false) — OCC has no Statsig and no
 * model-configured resume text, so the flag-off behavior is exact equality
 * against L/E.
 */
export function isUsageLimitContinuationText(text: string): boolean {
  return (
    text === USAGE_LIMIT_RESET_CONTINUATION_TEXT ||
    text === USAGE_AVAILABLE_CONTINUATION_TEXT
  )
}

/**
 * Official `Bme(e)` @247238964 (byte-verified):
 * `e.type==="user"&&!e.isMeta&&e.toolUseResult===void 0
 *  &&!e.isCompactSummary&&Lg(e.origin)`.
 */
function isTitleEligibleMessage(msg: Message): boolean {
  const withRuntime = msg as Message & {
    origin?: TitleMessageOrigin
    toolUseResult?: unknown
  }
  return (
    msg.type === 'user' &&
    !msg.isMeta &&
    withRuntime.toolUseResult === undefined &&
    !msg.isCompactSummary &&
    isHumanOrUndefinedOrigin(withRuntime.origin)
  )
}

/** Official `KFs(e){return e.find(Bme)}` @261919731. */
export function firstTitleEligibleMessage(
  messages: Message[],
): Message | undefined {
  return messages.find(isTitleEligibleMessage)
}

// ---------------------------------------------------------------------------
// zMr / uzn — title input derivation (item 78)
// ---------------------------------------------------------------------------

/**
 * Official `zMr({content,origin,commands,dispatchesSlashCommands})`
 * @261918331 (byte-verified):
 *
 *   let s=em(e); if(!s)return null;
 *   let l=BE(e)&&iN(e)||s, d;
 *   if(n&&s.startsWith(`<command-message>`)){
 *     let g=ci(s,'command-name')?.trim(); if(!g)return null;
 *     d={name:g.startsWith("/")?g.slice(1):g, args:ci(s,'command-args')?.trim()??""}
 *   } else if(M4(s))return null;
 *   else if(n&&BE(e)&&l7n(l,(g)=>Bbe(g,r)))d=yX(l.trim());
 *   else if(BE(l))return Xhn(l,r)||Xhn(s,r)?null:s;
 *   else return s;
 *   let m=Js(d.name,r), f=`/${d.name} ${d.args}`.trim();
 *   if(!$l(c)||m?.type!=="prompt"||!$d(m)||ak(m)||m.userInvocable===!1||Xhn(f,r))return null;
 *   let h=ne(pr((m.menuDescription??m.description).trim()),y);
 *   return h?`${f}\n${h}`:f
 *
 * OCC gate mapping: `$d(m)` (policy gate `qzo` + `isEnabled?.()??true`) ≡
 * OCC `isCommandEnabled` semantics — OCC has no per-command enterprise
 * policy gate. `ak(m)` (availability resolved to "off") is enforced upstream:
 * the REPL passes the already availability-filtered command list
 * (commands.ts `getCommands` filters `meetsAvailabilityRequirement &&
 * isCommandEnabled`), so `ak(m)` is false for every list member.
 */
export function titleInputFromMessage({
  content,
  origin,
  commands,
  dispatchesSlashCommands,
}: {
  content: TitleContentInput
  origin: TitleMessageOrigin | undefined
  commands: TitleCommand[]
  dispatchesSlashCommands: boolean
}): string | null {
  const s = contentToText(content)
  if (!s) return null
  const l = (startsWithSlashCommand(content) ? lastTextBlockContent(content) : null) || s
  let d: { name: string; args: string } | undefined
  if (dispatchesSlashCommands && s.startsWith(`<${COMMAND_MESSAGE_TAG}>`)) {
    const g = extractTagContent(s, COMMAND_NAME_TAG)?.trim()
    if (!g) return null
    d = {
      name: g.startsWith('/') ? g.slice(1) : g,
      args: extractTagContent(s, COMMAND_ARGS_TAG)?.trim() ?? '',
    }
  } else if (isNonProseBreadcrumb(s)) {
    return null
  } else if (
    dispatchesSlashCommands &&
    startsWithSlashCommand(content) &&
    startsAsKnownCommand(l, name => findTitleCommand(name, commands) !== undefined)
  ) {
    d = parseSlashCommand(l.trim())
  } else if (startsWithSlashCommand(l)) {
    return isSensitiveTitleInput(l, commands) || isSensitiveTitleInput(s, commands)
      ? null
      : s
  } else {
    return s
  }
  const m = findTitleCommand(d.name, commands)
  const f = `/${d.name} ${d.args}`.trim()
  if (
    !isHumanOrigin(origin) ||
    m?.type !== 'prompt' ||
    !(m.isEnabled?.() ?? true) ||
    m.userInvocable === false ||
    isSensitiveTitleInput(f, commands)
  ) {
    return null
  }
  const h = truncateText(
    firstLine((m.menuDescription ?? m.description ?? '').trim()),
    TITLE_DESCRIPTION_MAX,
  )
  return h ? `${f}\n${h}` : f
}

/**
 * Official `uzn({content,origin,queueSkipSlashCommands,commands})`
 * @261918957 (byte-verified):
 * `let s=em(e), l=r===!0; if(l&&(BE(e)||BE(s??"")))return null;
 *  return zMr({content:e,origin:c,commands:n,dispatchesSlashCommands:!l})`.
 */
export function titleInputFromQueuedMessage({
  content,
  origin,
  queueSkipSlashCommands,
  commands,
}: {
  content: TitleContentInput
  origin: TitleMessageOrigin | undefined
  queueSkipSlashCommands: boolean | undefined
  commands: TitleCommand[]
}): string | null {
  const s = contentToText(content)
  const skip = queueSkipSlashCommands === true
  if (skip && (startsWithSlashCommand(content) || startsWithSlashCommand(s ?? ''))) {
    return null
  }
  return titleInputFromMessage({
    content,
    origin,
    commands,
    dispatchesSlashCommands: !skip,
  })
}

// ---------------------------------------------------------------------------
// fzn / pzn — fallback state machine (item 61)
// ---------------------------------------------------------------------------

/**
 * Official `fzn({prose,isContinuationTurn,fallback})` @261919165
 * (byte-verified):
 * `if(e!==null&&_(e))return{text:e,unusableRepliesLeft:b};
 *  if(r&&(e!==null||c))return r;
 *  return`
 *
 * Meaningful prose starts a fresh fallback (2 unusable replies tolerated);
 * a too-short prose or a continuation turn PRESERVES the existing fallback
 * so the retry still titles the original prompt; anything else drops it.
 */
export function makeTitleFallback({
  prose,
  isContinuationTurn,
  fallback,
}: {
  prose: string | null
  isContinuationTurn: boolean
  fallback: TitleFallback | undefined
}): TitleFallback | undefined {
  if (prose !== null && isMeaningfulTitleText(prose)) {
    return { text: prose, unusableRepliesLeft: UNUSABLE_REPLIES_LEFT }
  }
  if (fallback && (prose !== null || isContinuationTurn)) return fallback
  return undefined
}

/**
 * Official `pzn(e,c)` @261919312 (byte-verified):
 * `switch(c.kind){case"titled":return; case"failed":return e;
 *  case"unusable":return e.unusableRepliesLeft>1?
 *    {text:e.text,unusableRepliesLeft:e.unusableRepliesLeft-1}:void 0}`
 *
 * A FAILED request (API error) preserves the fallback unchanged — the
 * QueryEngine resets `_haikuTitleAttempted` and retries the same text next
 * turn (the item 61 fix). An UNUSABLE result (e.g. "Prompt is too long")
 * burns one of the 2 tolerated replies.
 */
export function reduceTitleFallback(
  fallback: TitleFallback,
  result: SessionTitleRequestResult,
): TitleFallback | undefined {
  switch (result.kind) {
    case 'titled':
      return undefined
    case 'failed':
      return fallback
    case 'unusable':
      return fallback.unusableRepliesLeft > 1
        ? { text: fallback.text, unusableRepliesLeft: fallback.unusableRepliesLeft - 1 }
        : undefined
  }
}
