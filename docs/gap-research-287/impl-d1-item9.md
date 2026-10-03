# impl-d1-item9 — 2.1.287 CL:29 large MCP results saved as JSON must not be paged with Read offset/limit

> Official changelog 2.1.287 line 29: *"Fixed Claude being told to page large MCP results saved as JSON with Read's offset and limit, which cannot split one long line."*
>
> Source of truth: `gap-research-287/cluster-d1-api-session.md` §Item 9 (verbatim v287 `vsn` recovered byte-exact from the ELF @207465427) cross-checked against the read-only string dumps `/tmp/cc-diff-287/{s286,s287}.txt` (rg/dd reads only; nothing under `/tmp/cc-diff-287` was ever executed).
>
> **Verdict: PORTED — byte-verified.** Legacy `!QMt()` branch only (OCC has no `tengu_mcp_subagent_prompt` flag). 9/9 differential cases against the extracted official `vsn`+`mio` are byte-identical (modulo one documented pre-existing omission, §5.1). 19 new tests + 47 existing MCP tests green. Real end-to-end run through `processMCPResult` confirms all three branches (§4.3).

---

## 1. Changed files

| File | Lines | Change |
|---|---|---|
| `src/utils/mcpOutputStorage.ts` | +8–9 (imports), +32–93 (new types/helpers), +95–195 (rewritten builder) | `LargeOutputLineStats` type, `quoteArgvForShell` (byte-exact `XK`), `computePersistedLineStats` (official caller line-counting), `buildSummarizationRequirements` (official `mio`), `getLargeOutputInstructions` gains the 5th `lineStats?` param + the three-branch guidance |
| `src/services/mcp/client.ts` | +88 (import), +3528–3544 (call-site region only) | compute `lineStats` for plain-text persists and pass it to `getLargeOutputInstructions` |
| `src/utils/__tests__/mcpOutputJsonPaging287.test.ts` | new, 283 lines | 19 tests: all three branches, header phrasing, legacy byte-identity, shell quoting, `mio` ordering, `maxReadLength` note, `computePersistedLineStats` |

Diffstat (my lane only): `src/services/mcp/client.ts | 13 ++++`, `src/utils/mcpOutputStorage.ts | 158 ++++++++++++++++++++---` (+160/−11).

No other file was touched. `src/services/api/claude.ts`, `src/utils/model/modelOptions.ts`, `src/components/*`, tools/shell/permission files were left alone (other agents are editing them in this worktree — `git status` shows their changes, not mine). The `client.ts` alwaysLoad region near the top of the file was not touched.

---

## 2. Helper mapping (official minified → OCC)

| Official (v287 ELF) | Meaning | OCC equivalent | Confidence |
|---|---|---|---|
| `vsn(path,len,fmt,s,g,h)` | large-output guidance builder | `getLargeOutputInstructions(rawOutputPath, contentLength, formatDescription, maxReadLength?, lineStats?)` | exact |
| `g` (`{count,maxLen}`) | line-shape stats of the persisted file | `LargeOutputLineStats` / 5th param `lineStats` | exact |
| `j = Math.floor(OQ().maxTokens*4*0.8)` | chunk-size threshold (25000 → **80000** chars) | `Math.floor(getDefaultFileReadingLimits().maxTokens * 4 * 0.8)` (`src/tools/FileReadTool/limits.ts`, default `DEFAULT_MAX_OUTPUT_TOKENS = 25000`) | exact |
| `K = g!==void 0 && g.count>1 && g.maxLen<=j` | "many short lines" ⇒ offset/limit paging is safe | `hasChunkableLines` (same three conjuncts, same order) | exact |
| `dt` | Read tool display name | `FILE_READ_TOOL_NAME` (`'Read'`, `src/tools/FileReadTool/prompt.ts`) | exact |
| `yt` | Task tool name | not needed — only the `QMt()` subagent variant references it (deferred, §5.2) | n/a |
| `Ur([e])` (alias of `XK`) | POSIX argv quoter used inside the jq-probe hint | new private `quoteArgvForShell()` — byte-exact `XK` port. OCC's shell-quote based `src/utils/bash/shellQuote.ts` `quote()` was **rejected**: it switches to double-quote mode and escapes `!`, which would not be byte-identical inside the prompt | exact (own port) |
| `mio(e,n,r)` | REQUIREMENTS block builder; `r` = the shape note placed between the read bullet and the truncation bullet | new private `buildSummarizationRequirements(rawOutputPath, maxReadLength, extraNote)` | exact |
| `s` (4th param of `vsn`) | Bash char-limit for the truncation bullet | existing `maxReadLength` param — semantics unchanged | exact |
| caller `ie = R==="toolResult" \|\| k!==void 0` | gate: stats only when persisted as plain text (`k` = singleton text-block unwrap behind `tengu_mcp_singleton_unwrap`) | `type === 'toolResult'` in `processMCPResult` | **PARTIAL** — OCC has no singleton-text unwrap, so the `k` half of the disjunction has no counterpart (§5.3) |
| caller line counting `ce=j.split("\n"); if(ce.length>1&&ce.at(-1)==="")ce.pop(); he=max(len)` | one trailing newline is not a phantom line | `computePersistedLineStats(content)` — same drop-one-trailing-empty rule, single pass | exact |
| `QMt()` | `MCP_TRUNCATION_PROMPT_OVERRIDE` env / `tengu_mcp_subagent_prompt` flag → subagent-routing variant + `he=Math.max(1,Math.floor(j/(g.maxLen+8)))` chunk-line math | not ported — flag absent in OCC | **deferred** (§5.2) |
| `pn(n)` + `h`/`truncatedAtBytes` | the truncated-file size note (`H`) | OCC's `persistToolResult` never reports a byte-limit truncation, so there is no `h` to render — behavior left exactly as today | n/a (no OCC surface) |
| `OQ()` | `defaultFileReadingLimits ??= {maxSizeBytes:262144, maxTokens:25000}` | `getDefaultFileReadingLimits()` (same 25000 default) | exact |

**Naming note (report correction, no code impact):** the gap report says v286's `ltn` "had none of this line-shape branching". Reading `s286.txt` again, v286 already had `g`/`K`, the "characters across N lines" header and the subagent variant; what v286 lacked was branching in the **legacy** path (it always emitted the offset/limit text and passed a boolean `Te` to `Uto`). v287's delta is precisely the legacy three-way branch + the jq-probe/char-range notes. The port implements the v287 shape, which is what the changelog entry describes.

**Semantic correction:** `OQ().maxTokens` is the Read tool's *default file-reading limit* (25000), **not** the model's max output tokens. OCC's `getDefaultFileReadingLimits()` is therefore the faithful source; `j` = 80000 chars either way.

---

## 3. Exact new / changed strings

All from the verbatim v287 `vsn` (report §Item 9); no invented wording.

### 3.1 Header (`w`) — line-count phrasing added only when `lineStats` is defined

```
Error: result (${sizeDescription}) exceeds maximum allowed tokens. Output has been saved to ${rawOutputPath}.
Format: ${formatDescription}
```

where

```
sizeDescription = lineStats !== undefined
  ? `${contentLength.toLocaleString()} characters across ${lineStats.count.toLocaleString()} ${lineStats.count === 1 ? 'line' : 'lines'}`
  : `${contentLength.toLocaleString()} characters`
```

With `lineStats` omitted the header is **byte-identical to the pre-287 text** (asserted in test 1).

### 3.2 Branch A — `lineStats === undefined` (JSON-persisted / unmeasured) ← *the 2.1.287 bug fix*

Read strategy:

```
Use jq to make structured queries (find a value, filter by field).
```

Shape note (`Ae`, rendered by `mio` between the read bullet and the truncation bullet):

```
- Note: this file is JSON, so a long value (or the whole file) is a single line. Read's offset/limit cannot split a line, so reading in chunks works only if every line is short. If a shell tool is available, first probe the structure (e.g., jq 'type, length, keys?' ${quoteArgvForShell([rawOutputPath])}), then extract slices with jq or python.
```

(`Read` is `${FILE_READ_TOOL_NAME}`; the path is argv-quoted by the byte-exact `XK` port, so `/tmp/it's/out.json` renders as `'/tmp/it'"'"'s/out.json'`.)

### 3.3 Branch B — `!K` (lines too long to chunk)

Read strategy:

```
Search within the file for specific content, and use jq if the content is JSON.
```

Shape note:

```
- Note: this file's lines are too long for Read's offset/limit chunking. If a shell tool is available, slice by character range (e.g. python read()[A:B], dd, or cut -c) instead.
```

### 3.4 Branch C — `K` (many short lines)

Read strategy (unchanged from today):

```
Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries.
```

Shape note: `''` (empty).

### 3.5 Composition (`mio` equivalent, unchanged bullets)

```
<header><readStrategy>REQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:
- You MUST read the content from the file at ${rawOutputPath} in sequential chunks until 100% of the content has been read.
${shapeNote}- If you receive truncation warnings when reading the file${maxReadLength ? ` ("[N lines truncated]")` : ''}, reduce the chunk size until you have read 100% of the content without truncation${maxReadLength ? ` ***DO NOT PROCEED UNTIL YOU HAVE DONE THIS***. Bash output is limited to ${maxReadLength.toLocaleString()} chars` : ''}.
- Before producing ANY summary or analysis, you MUST explicitly describe what portion of the content you have read. ***If you did not read the entire content, you MUST explicitly state this.***
```

The `maxReadLength` ("Bash output is limited to N chars") bullet keeps its existing truthy test and renders in all three branches (test 15).

### 3.6 Call site (`src/services/mcp/client.ts:3528–3544`)

```ts
// CC 2.1.287 #29: compute the persisted content's line-shape stats ONLY for
// plain-text results. Official gates the stats on `ie = type==="toolResult"
// || unwrappedSingletonText !== undefined` and leaves them undefined for
// JSON-persisted results, so the guidance says the file is JSON (Read's
// offset/limit cannot split its one long line) instead of recommending
// offset/limit paging. OCC has no singleton-text unwrap, so the gate is
// `type === 'toolResult'`.
const lineStats =
  type === 'toolResult' ? computePersistedLineStats(contentStr) : undefined

const formatDescription = getFormatDescription(type, schema)
return getLargeOutputInstructions(
  persistResult.filepath,
  persistResult.originalSize,
  formatDescription,
  undefined,
  lineStats,
)
```

No threading was needed: `contentStr` (`typeof content === 'string' ? content : jsonStringify(content, null, 2)`) is the exact string handed to `persistToolResult` and is already in scope at this site, so the stats are computed over precisely what landed on disk (`persistResult.originalSize === contentStr.length`).

---

## 4. Verification

### 4.1 New tests — `src/utils/__tests__/mcpOutputJsonPaging287.test.ts`

```
bun test src/utils/__tests__/mcpOutputJsonPaging287.test.ts
 19 pass, 0 fail, 42 expect() calls
```

Coverage: legacy header byte-identity when `lineStats` omitted · `characters across 1,000 lines` / singular `1 line` · full-text exact assertion of branch A · absence of `Use offset and limit parameters` in branches A and B (the actual bug) · shell quoting of paths with spaces and single quotes · branch B for `count===1` huge, `count===1` short, and `maxLen===j+1` · branch C for 1000×200 and `maxLen===j` exactly (K uses `<=`) · `mio` bullet ordering (read < note < truncation < completion) · `maxReadLength` bullet in all three branches · 5 `computePersistedLineStats` cases (trailing-newline drop, single line, interior empty line, empty content, maxLen pass).

### 4.2 Regression + lint

```
bun test src/utils/__tests__/mcpOutputJsonPaging287.test.ts \
         src/services/mcp/__tests__/maxResultSizeChars.test.ts \
         src/services/mcp/__tests__/mcpSlice218.test.ts \
         src/services/mcp/__tests__/alwaysLoad285.test.ts
 66 pass, 0 fail, 623 expect() calls   (4 files, 994 ms)

bunx biome lint src/utils/mcpOutputStorage.ts src/services/mcp/client.ts \
                src/utils/__tests__/mcpOutputJsonPaging287.test.ts
 Checked 3 files. No fixes applied.   (clean)
```

Full suite intentionally not run (per task instruction; other agents are mid-edit in this worktree). `rg` confirms no other test asserts the old guidance text and no pre-existing test imports `mcpOutputStorage`/`persistToolResult`.

### 4.3 Differential harness against the extracted official `vsn` (byte-identity)

`/tmp/verify287/verify.ts` loads the verbatim v287 `vsn` + `mio` + `XK` source (extracted from the ELF dump into `/tmp/verify287/official_vsn_mio.js` / `official_xk.js` — extracted copies, the dump itself was only read), executes it via `new Function` with faithful stubs (`QMt=()=>false`, `dt='Read'`, `yt='Task'`, `OQ=()=>({maxTokens:25000,maxSizeBytes:262144})`, `Ur=XK`, `pn`) and diffs against OCC's builder:

```
OK   json/undefined stats (1159 bytes, trailing-bullet-present=true)
OK   json/undefined stats + maxReadLength (1269 bytes, trailing-bullet-present=true)
OK   json/undefined stats + spaced path (1078 bytes, trailing-bullet-present=true)
OK   single long line (!K) (999 bytes)
OK   count=1 short line (!K) (994 bytes)
OK   maxLen = J+1 (!K) (1111 bytes)
OK   many short lines (K) (891 bytes)
OK   maxLen = J exactly (K) (887 bytes)
OK   K + maxReadLength (999 bytes)

ALL BYTE-IDENTICAL (modulo the documented trailing bullet, §5.1)
```

### 4.4 Real end-to-end run through `processMCPResult`

The persist path is gated by `mcpContentNeedsTruncation` → `countMessagesTokensWithAPI`, which needs a live `count_tokens` endpoint (no API key in this sandbox ⇒ its catch returns `false` ⇒ no guidance). `/tmp/verify287/integration2.ts` serves `POST /v1/messages/count_tokens` on `127.0.0.1:8799` (`{"input_tokens":999999}`), points `ANTHROPIC_BASE_URL` at it, installs the `cli.tsx` dev globals (`MACRO`/`BUILD_TARGET`/…) and `CLAUDE_CONFIG_DIR=/tmp/verify287/cfg`, then calls the real `processMCPResult`:

| Input | Result |
|---|---|
| `toolResult`, 4000 short lines (282,890 chars) | `Error: result (282,890 characters across 4,000 lines) …` + `Format: Plain text` + **branch C** (`Use offset and limit parameters …`). Persisted file: 282,890 chars / 4001 raw lines ⇒ the trailing-newline drop is correct (4,000, not 4,001). |
| `structuredContent`, 6000 rows (352,900 chars) | `Error: result (352,900 characters) …` (**no** line-count phrasing) + `Format: JSON with schema: {rows: [{...}]}` + **branch A** (`Use jq to make structured queries …` + the `- Note: this file is JSON …` bullet). No offset/limit recommendation — the reported bug is gone. Persisted file: 1 raw line. |
| `toolResult`, single 352,900-char JSON line | `Error: result (352,900 characters across 1 line) …` + `Format: Plain text` + **branch B** (`Search within the file …` + `- Note: this file's lines are too long for Read's offset/limit chunking …`). |

3 count_tokens hits, all three branches exercised through the real call site, real persistence and real guidance text.

---

## 5. Deviations / PARTIALs / deferred

### 5.1 Trailing "few attempts" bullet NOT added (deliberate, pre-existing gap)

Official `mio` ends with:

```
- If after a few attempts you cannot read the file (file not found, lines too long for Read's offset/limit, no shell access), STOP retrying. Summarize what you were able to read, explicitly state which portion you could not read and why, and proceed.
```

That bullet is present in **v286 and v287 alike** (`s286.txt` / `s287.txt`), and OCC's pre-287 builder (`git show HEAD:src/utils/mcpOutputStorage.ts`) never had it. It is therefore a pre-existing OCC divergence, not part of this changelog delta, and adding it would change the output of *every* existing caller of `getLargeOutputInstructions` (including non-MCP ones) — outside this task's lane. The harness accounts for it by stripping exactly that suffix before comparison. **Recommended follow-up:** a separate one-line port + test, since the wording interacts with the new "lines too long" note.

### 5.2 `QMt()` subagent variant DEFERRED

The official `vsn` opens with `if(QMt()){…}` — a subagent-routing variant that recommends dispatching a Task agent and computes a chunk-line count `he = Math.max(1, Math.floor(j/(g.maxLen+8)))` (the `+8` is the official per-line overhead estimate). `QMt()` is the `MCP_TRUNCATION_PROMPT_OVERRIDE` env override OR the `tengu_mcp_subagent_prompt` flag; OCC has neither, so the legacy branch is the only reachable one and the variant is not ported (per task scope). `${yt}` (Task tool) is consequently unreferenced. If OCC ever grows the flag, the port is mechanical: add the branch + `he`, reusing `computePersistedLineStats` and the same `j`.

### 5.3 Caller gate is PARTIAL (`type === 'toolResult'` only)

Official: `ie = R==="toolResult" || k!==void 0`, where `k` is the singleton text-block unwrap behind `tengu_mcp_singleton_unwrap` (a `contentArray` holding exactly one text block is unwrapped to a plain string and persisted as text). OCC has no singleton-unwrap step, so a single-text-block `contentArray` is JSON-persisted and correctly falls into branch A. Conservative and faithful for OCC's actual persistence behavior — no case can claim "plain text" stats for JSON-persisted content.

### 5.4 Persist byte-limit note (`H`) not implemented — unchanged

The official builder takes a 6th arg `h` (truncated-at-bytes from the persist limit) and renders a note via `pn()`. OCC's `persistToolResult` writes the whole string and returns `{filepath, originalSize, isJson, preview, hasMore}` with no byte-limit truncation, so there is nothing to report. Behavior left exactly as today (no `h` param added) rather than inventing a note that could never fire.

### 5.5 Observation, out of lane: JSON-persisted MCP output gets a `.txt` extension

Official names JSON-persisted MCP results `.json`; OCC's `persistToolResult` (`src/utils/toolResultStorage.ts`) always writes `.txt` on the MCP path (confirmed live in §4.4: `mcp-srv-search-…txt` holding one JSON line). Cosmetic-only for this fix — the new branch A note tells Claude the file *is* JSON regardless of extension, and `jq` does not care — but it makes the guidance/self-describing-filename story slightly weaker. Changing it lives in `toolResultStorage.ts`, outside my file lane; flagged for the orchestrator.

---

## 6. One-line summary

`getLargeOutputInstructions` is now line-shape aware and byte-identical to the official v287 legacy builder: JSON-persisted (unmeasured) results get the jq-probe note instead of an offset/limit paging recommendation, plain-text results with over-long lines get the char-range slicing note, and only many-short-lines results keep the classic offset/limit text — with `client.ts` computing the stats over exactly the bytes it persisted.
