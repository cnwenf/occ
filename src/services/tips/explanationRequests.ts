/**
 * claude-code 2.1.311 triage-T1 item 2 — the "explanation request" signal that
 * gates the `explanatory-output-style` spinner tip.
 *
 * Official keeps the count on the tip-context host and absorbs the transcript
 * incrementally (v311 @275870968 `explanationRequestCount:` field /
 * @275871074 `_absorbNewSessionSignals` / @275871404 `_absorbSessionSignals`,
 * all byte-verified verbatim):
 *
 *   `{...,explanationRequestCount:this._explanationRequestIds.size,...}`
 *
 *   `_absorbNewSessionSignals(){let h=this._requireHost().transcript.getSnapshot();
 *     this._absorbSessionSignals(h.slice(this._signalsAbsorbedLength)),
 *     this._signalsAbsorbedLength=h.length}`
 *
 *   `_absorbSessionSignals(h){for(let x of h){
 *     let D=!Lv(x)?void 0
 *       :x.type==="user"
 *         ?Aar(x)||x.promptSource==="suggestion_accepted"?void 0:x.message.content
 *         :x.type==="attachment"&&x.attachment.type==="queued_command"
 *            &&x.attachment.commandMode==="prompt"&&x.attachment.isMeta!==!0
 *            &&x.attachment.inputSource!=="suggestion_accepted"
 *           ?x.attachment.prompt:void 0;
 *     if(D!==void 0&&mSs(Gpr(Fp(D)??"")))this._explanationRequestIds.add(x.uuid);
 *     ...}}`
 *
 *   `function Lv(e){try{if(e.type==="user")return Pd(e.origin)
 *      &&e.toolUseResult===void 0&&e.isCompactSummary!==!0
 *      &&e.verifiedSlackHumanTurn!==!0;
 *      return e.type==="attachment"&&e.attachment.type==="queued_command"
 *        &&Pd(e.attachment.origin)&&e.attachment.verifiedSlackHumanTurn!==!0
 *    }catch{return!1}}`                          (v311 @242404855)
 *   `function Pd(e){return e?.kind==="human"}`    (v311 @242404732)
 *   `function Aar(e){return e.isMeta===!0||e.textNotTyped===!0
 *      ||e.handedOff===!0||e.queueSkipAttachments===!0
 *      ||e.queueTranscriptOnly===!0}`            (v311 @242405145)
 *
 * `Gpr` (v311 @238958554) and `mSs` (v311 @257316911) are ported verbatim
 * below. `Fp(D)` is official's message-content → text projection; OCC's
 * equivalent is `getContentText` in utils/messages.js, kept local here (same
 * string/array semantics) so the tip registry does not pull the 5k-line
 * message module into its import graph.
 *
 * OCC reduction: `Pd(origin)` (`origin.kind === "human"`) is dropped — OCC
 * messages carry no `origin` tag, so requiring it would pin the count at zero
 * and the tip would never fire. The remaining `Lv`/`Aar` exclusions
 * (`toolUseResult`, `isCompactSummary`, `verifiedSlackHumanTurn`, `isMeta`,
 * `textNotTyped`, `handedOff`, `queueSkipAttachments`, `queueTranscriptOnly`,
 * `promptSource`) are read defensively: OCC sets some of them today and the
 * others may arrive on a resumed transcript, so every official exclusion still
 * applies whenever the field is present.
 */

/**
 * Official `var z=` (v311 @238958482; the regex literal starts @238958488) —
 * `<ide_opened_file>` / `<ide_selection>`. Byte-identical to the binary.
 */
const IDE_ATTACHMENT_BLOCK_PATTERN =
  /<(ide_opened_file|ide_selection)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

/**
 * Official `mSs`'s detector (v311 @257317005, byte-verbatim). Non-global, so
 * `.test()` carries no `lastIndex` state between calls.
 */
const EXPLANATION_REQUEST_PATTERN =
  /^(?:(?:ok|okay|please|pls|can you|could you|would you),? )*(?:explain|walk me through|help me understand|teach me)\b|^(?:why (?:does|do|is|are|was|were|would|should) (?!you\b|u\b)(?![^.?!]*\b(?:still|again)\b)|how (?:come|does|do (?:these|those)) |what (?:does|do) (?!you\b|u\b|we\b|i\b)|what(?:'s| is) (?:this|that)\b|i (?:don'?t|do not) (?:understand\b|get (?:this|it|why|how|what)\b))/

/** Curly apostrophe normalization, official `.replace(/’/g,"'")`. */
const RIGHT_SINGLE_QUOTE_PATTERN = /’/g

/** Collapses the whitespace runs official's `.replace(/\s+/g," ")` targets. */
const WHITESPACE_RUN_PATTERN = /\s+/g

/** Official `_explanationRequestIds` — a session-scoped set of message uuids. */
const explanationRequestIds = new Set<string>()

/** Official `_signalsAbsorbedLength` — how much of the transcript is scanned. */
let absorbedEntryCount = 0

/**
 * Official `Gpr` (v311 @238958554): `function Gpr(t){return t.replace(z,"").trim()}`.
 * `String.replace` with a global pattern resets `lastIndex` on completion, so
 * the shared pattern is safe to reuse.
 */
export function stripIdeAttachmentBlocks(text: string): string {
  return text.replace(IDE_ATTACHMENT_BLOCK_PATTERN, '').trim()
}

/**
 * Official `mSs` (v311 @257316911, byte-verbatim):
 *   `function mSs(e){let n=e.toLowerCase().replace(/’/g,"'")
 *      .replace(/\s+/g," ").trim();return/<detector>/.test(n)}`
 *
 * True when the text is the user asking to be taught / expressing confusion,
 * which is the behaviour the Explanatory output style automates.
 */
export function isExplanationRequest(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(RIGHT_SINGLE_QUOTE_PATTERN, "'")
    .replace(WHITESPACE_RUN_PATTERN, ' ')
    .trim()
  return EXPLANATION_REQUEST_PATTERN.test(normalized)
}

/**
 * Official `_absorbNewSessionSignals()` — scans only the transcript entries
 * appended since the previous call, adds every matching message uuid to the
 * session set, and returns the running count (`_explanationRequestIds.size`).
 *
 * Accepts `readonly unknown[]` and narrows internally so a malformed or
 * partially-typed transcript entry can never throw (official wraps the whole
 * absorb in `try{...}catch(h){l(...)}`).
 */
export function absorbExplanationRequests(messages: readonly unknown[]): number {
  const newEntries = messages.slice(absorbedEntryCount)
  absorbedEntryCount = messages.length
  for (const entry of newEntries) {
    const id = countableExplanationRequestId(entry)
    if (id !== undefined) {
      explanationRequestIds.add(id)
    }
  }
  return explanationRequestIds.size
}

/** Official read of `_explanationRequestIds.size` for the tip context. */
export function getExplanationRequestCount(): number {
  return explanationRequestIds.size
}

/** Official `_resetSessionSignals()` half that clears the explanation ids. */
export function resetExplanationRequests(): void {
  explanationRequestIds.clear()
  absorbedEntryCount = 0
}

/**
 * Returns the entry's uuid when it is a human prompt that asks for an
 * explanation, otherwise undefined.
 */
function countableExplanationRequestId(entry: unknown): string | undefined {
  if (!isRecord(entry) || !isCountableTranscriptEntry(entry)) {
    return undefined
  }
  const { uuid } = entry
  if (typeof uuid !== 'string') {
    return undefined
  }
  const text = transcriptEntryText(entry)
  if (text === undefined) {
    return undefined
  }
  return isExplanationRequest(stripIdeAttachmentBlocks(text)) ? uuid : undefined
}

/**
 * Official `Lv(x)` plus the inline `Aar(x)` / `promptSource` / attachment
 * branch of `_absorbSessionSignals`, minus the `Pd(origin)` clause (see the
 * module docblock).
 */
function isCountableTranscriptEntry(entry: Record<string, unknown>): boolean {
  if (entry.type === 'user') {
    return (
      entry.toolUseResult === undefined &&
      entry.isCompactSummary !== true &&
      entry.verifiedSlackHumanTurn !== true &&
      entry.isMeta !== true &&
      entry.textNotTyped !== true &&
      entry.handedOff !== true &&
      entry.queueSkipAttachments !== true &&
      entry.queueTranscriptOnly !== true &&
      entry.promptSource !== 'suggestion_accepted'
    )
  }
  if (entry.type !== 'attachment') {
    return false
  }
  const attachment = entry.attachment
  if (!isRecord(attachment)) {
    return false
  }
  return (
    attachment.type === 'queued_command' &&
    attachment.commandMode === 'prompt' &&
    attachment.isMeta !== true &&
    attachment.inputSource !== 'suggestion_accepted' &&
    attachment.verifiedSlackHumanTurn !== true
  )
}

/** Official `D` — the raw content the detector runs against. */
function transcriptEntryText(
  entry: Record<string, unknown>,
): string | undefined {
  if (entry.type === 'attachment') {
    const attachment = entry.attachment
    return isRecord(attachment) && typeof attachment.prompt === 'string'
      ? attachment.prompt
      : undefined
  }
  const message = entry.message
  if (!isRecord(message)) {
    return undefined
  }
  return contentText(message.content)
}

/**
 * Official `Fp(D)` — projects message content to text. Returns undefined when
 * there is no text at all, mirroring `Fp(D) ?? ""` (an empty projection can
 * never match the anchored detector).
 */
function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return undefined
  }
  const parts = content
    .filter(
      (block): block is { type: string; text: string } =>
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map(block => block.text)
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** Structural narrowing for untrusted transcript entries. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
