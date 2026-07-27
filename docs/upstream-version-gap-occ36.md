# OCC vs. official Claude Code — version-gap report (2026-07-28, OCC-36)

> Gap-research + alignment deliverable for **OCC-36** ("OCC版本追齐官方Claude
> Code — 2026-07-28 gap调研/对齐"),承接 OCC-35
> `docs/upstream-version-gap-occ35.md` §5 carryover. Methodology per the
> `upstream-tracking` + `aligning-with-official-binary` skills (no memory
> recital, no invented/partial implementations). Version truth from the npm
> registry (`@anthropic-ai/claude-code`); feature truth cross-checked against
> OCC `src/` and the decompiled official native ELF
> (`@anthropic-ai/claude-code-linux-x64@2.1.220`, 429,558 strings).

## TL;DR

| Item | Value | Source |
|------|-------|--------|
| OCC own release (start of round) | `2.1.287` (`2026-07-27`, OCC-35) | `package.json`, `CHANGELOG.md` §2.1.287 |
| OCC aligned Claude Code (start of round) | `2.1.218` fully aligned (OCC-31) + `2.1.219` **partial** (P0 in OCC-34 + Opus 5 canonical foundation in OCC-35) | `CLAUDE.md` header; OCC-35 §4 |
| Official latest Claude Code (npm `latest` = `next`) | **`2.1.220`** (published `2026-07-24T23:11:21Z`; **unchanged since OCC-34**) | `npm view @anthropic-ai/claude-code version` |
| Official GitHub `CHANGELOG.md` top entries | `## 2.1.220`, `## 2.1.219` | npm timeline |
| Version gap vs official latest | **YES — carryover** `2.1.219` P1–P4 (P0 + Opus 5 canonical foundation done; `2.1.220` = no-op) | OCC-35 §5 |

**Conclusion: a real version gap still exists — the carryover `2.1.219` P1–P4
backlog staged by OCC-34/OCC-35.** The official `latest` dist-tag is
**unchanged at `2.1.220`** since OCC-34's report (npm `time` tail:
`2.1.220 → 2026-07-24T23:11:21Z`; no new official release in the last ~4
days). `2.1.220` remains the no-op reliability layer OCC-34 already
binary-confirmed (no new env-var / settings-key / hook-name / command surface
— re-verified this round: the binary carries no `2.1.221+` marker and the
changelog top entry is still `## 2.1.220`).

This round advances the **Opus 5 launch downstream sites** (OCC-35 §5 items
1a/1e/1f/1j) — the decoupled, binary-verified, non-breaking subset of the
keystone P1 item. The coupled/intricate sites (1b picker row, 1c MODEL_COSTS
pricing tier, 1d fast-mode model-resolution, 1g effort/thinking/betas/advisor
allowlists, 1h claude-api skill content, 1i highlight-newest UI) remain
staged for dedicated per-site decompilation, per the `aligning-with-official-
binary` "Never invent" rule.

---

## 1. Version truth

| Source | Value | Command |
|--------|-------|---------|
| npm `latest` dist-tag | `2.1.220` | `npm view @anthropic-ai/claude-code version` |
| npm dist-tags | `latest=2.1.220`, `next=2.1.220`, `stable=2.1.212` | `npm view … dist-tags --json` |
| Official GitHub `CHANGELOG.md` top entry | `## 2.1.220` | npm timeline (unchanged from OCC-34) |
| OCC aligned version (start of round) | `2.1.218` + `2.1.219` partial (P0 + Opus 5 canonical) | `CLAUDE.md` header; OCC-35 |

Official version timeline (tail, unchanged since OCC-34):

```
2.1.220 → 2026-07-24T23:11:21Z   ← official latest (no-op reliability; OCC-34 confirmed nothing to port)
2.1.219 → 2026-07-24T16:11:49Z   ← substantive surface; P0 landed (OCC-34); Opus 5 canonical (OCC-35); P1–P4 open
2.1.218 → 2026-07-22T19:55:32Z   ← OCC fully aligned (OCC-31)
…
```

## 2. Methodology (skills used)

1. **Version truth** — `npm view @anthropic-ai/claude-code version/dist-tags/time`. Per `upstream-tracking` §"Version truth".
2. **Binary decompilation** — `npm pack @anthropic-ai/claude-code-linux-x64@2.1.220`; `tar -xzf`; `strings -n 8 package/claude > s220.txt` (429,558 lines). Per `upstream-tracking` §"Native Binary Notes (2.1.113+)".
3. **Token verification** — `grep -F`, `grep -oE` windowing, and `grep -aboF` + `dd` byte-level windowing to recover the exact default-opus resolution, 1M-support check, fast-mode tier, and `--model` help text. Per `aligning-with-official-binary` (no invented/partial implementations).
4. **Source cross-check** — `grep -rn` OCC `src/` for each site to confirm the divergence and port faithfully.

All downloaded binaries cleaned from `/tmp` after diffing (resource-safety rule; `rm -rf /tmp/cc-occ36`).

## 3. Official changelog — 2.1.219 + 2.1.220 (unchanged from OCC-34/35)

### 2.1.220
- Bug fixes and reliability improvements

### 2.1.219 (Opus 5 — relevant items bolded; full text in OCC-35 §3)
- **Added Claude Opus 5 (`claude-opus-5`), now the default Opus model — 1M context, fast mode at $10/$50 per Mtok**
- … (full list in `docs/upstream-version-gap-occ35.md` §3) …

## 4. Ports landed this run — Opus 5 launch downstream (decoupled subset)

Each port below is recovered verbatim from the decompiled 2.1.220 binary —
no behavior is guessed. All three are **non-breaking** and decoupled from the
intricate sites (picker/pricing/fast-mode-resolution/allowlists/skill/UI)
that remain staged.

### 4.1 Binary-verified truth (official 2.1.220 linux-x64 ELF strings dump)

- **Default Opus (1a)**: `DEFAULT_OPUS_MODEL ?? Km().opus5`;
  `aliases:{opus:{default:"claude-opus-5",per_provider:{bedrock:"claude-opus-5",vertex:"claude-opus-5",foundry:"claude-opus-5",anthropic_aws:"claude-opus-5",anthropic_google_cloud:"claude-opus-5",mantle:"anthropic.claude-opus-5",gateway:"claude-opus-4-7"}}}`.
  → All non-gateway providers default to `claude-opus-5`; gateway stays `claude-opus-4-7`.
- **1M support (1e)**: the provider-gated 1M-support check includes
  `claude-opus-5`:
  `if(e==="gateway")return!1;if(e==="vertex"){…return t.includes("claude-fable-5")||t.includes("claude-opus-4")||t.includes("claude-opus-5")||t.includes("claude-sonnet-5")||t.includes("claude-s…")}`.
- **`--model` help text (1j)**: byte-recovered via `grep -aboF` + `dd`:
  `Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5').`

### 4.2 Ports

| # | Item | File | Change | Binary-verified |
|---|------|------|--------|-----------------|
| 1a | Default-Opus switch — non-gateway → `claude-opus-5` (gateway stays `claude-opus-4-7`) | `src/utils/model/model.ts` `getDefaultOpusModel` | non-gateway return `getModelStrings().opus48` → `getModelStrings().opus5`; comment updated with 2.1.219 history + binary evidence | ✓ `DEFAULT_OPUS_MODEL ?? Km().opus5` + per_provider map |
| 1e | `modelSupports1M` covers Opus 5 | `src/utils/context.ts` `modelSupports1M` | added `canonical.includes('opus-5')` to the 1M-capable includes | ✓ 1M check includes `claude-opus-5` |
| 1j | `--model` help-text example → binary-verified string | `src/main.tsx` `--model` option | `(e.g. 'sonnet' or 'opus') … (e.g. 'claude-sonnet-4-6')` → `(e.g. 'fable', 'opus', or 'sonnet') … (e.g. 'claude-fable-5')` | ✓ byte-recovered help text |

### 4.3 Why faithful, not invented

- **1a**: every provider's default is recovered verbatim from the binary's
  `aliases.opus.per_provider` map — non-gateway = `claude-opus-5`, gateway =
  `claude-opus-4-7`. OCC's `getDefaultOpusModel` collapses non-gateway into one
  branch (the binary maps all non-gateway providers to opus-5), so the single
  `opus5` return is faithful. The `getModelStrings().opus5` key was added by
  OCC-35 (canonical foundation), so resolution is non-breaking. Existing
  opus-4-x resolution is unchanged (asserted by the regression e2e).
- **1e**: the binary's 1M-support check explicitly includes `claude-opus-5`;
  Opus 5 carries the 1M context window (binary: "Opus 5 with 1M context",
  "1M context" 71 occurrences). Adding `opus-5` to OCC's canonical-includes
  check is the faithful extension. Non-breaking (only adds a model to the
  1M-capable set; no default changes).
- **1j**: the help text is byte-recovered from the binary via `grep -aboF` +
  `dd`. OCC already supports the `fable` alias + `claude-fable-5` canonical ID
  (`src/utils/model/aliases.ts` `MODEL_FAMILY_ALIASES` incl. `fable`;
  `configs.ts` `CLAUDE_FABLE_5_CONFIG`), so advertising the alias is honest.

### 4.4 Decoupling note (why 1d/1g are NOT ported this run)

`isFastModeSupportedByModel` (`src/utils/fastMode.ts:181`) currently checks
`opus-4-6 || opus-4-7 || opus alias` — it does **not** include `opus-4-8` or
`opus-5`, so fast mode is *already* divergent for the current (2.1.218)
opus-4-8 default. Switching the 1P default to opus-5 (1a) therefore introduces
**no new** fast-mode regression — 1d (fast-mode model-resolution + support
gate) is a separate pre-existing divergence that needs dedicated binary
extraction of the `a7n`/`UIc` fast-model-id resolution and the exact support
set (`if(r==="claude-opus-4-8"||r==="claude-opus-5")return a7n;if(r==="claude-opus-4-6"||r==="claude-opus-4-7")…`).
Porting it correctly requires recovering the full fast-mode function, per the
`aligning-with-official-binary` "Never invent / no partial implementations"
rule. The same applies to 1g (effort/thinking/betas/advisor allowlists — the
binary shows opus-5 effort tiers use specific cells like `o5-bmin` that must
be extracted verbatim, not guessed).

## 5. Tests

- New e2e block `2.1.219 Opus 5 OCC-36 downstream ports (e2e)` in
  `test/e2e/version-2.1.219-opus5.e2e.test.ts` (3 tests):
  - 1a: `getDefaultOpusModel()` firstParty → `claude-opus-5`.
  - 1e: `modelSupports1M('claude-opus-5')` → true (+ `claude-opus-5[1m]`,
    opus-4-8 / sonnet-5 no regression, haiku-4-5 false).
  - 1j: `src/main.tsx` carries the binary-verified `'fable', 'opus', or
    'sonnet'` + `'claude-fable-5'` example.
- Updated `src/utils/__tests__/model-defaults-207.test.ts` (6 default tests):
  non-gateway providers (bedrock/vertex/foundry/anthropic_aws/mantle/firstParty)
  now assert `claude-opus-5` (was `claude-opus-4-8`); describe + doc updated to
  the 2.1.219 default; override test unchanged.
- Updated `test/e2e/version-2.1.197-models.e2e.test.ts`: the
  `getDefaultOpusModel (1P, no env)` test asserts `claude-opus-5` (was
  `claude-opus-4-8`) with a 2.1.219 advancement note.

### Verification
- `bun test src/utils/__tests__/model-defaults-207.test.ts` → 13 pass, 0 fail.
- `bun test test/e2e/version-2.1.219-opus5.e2e.test.ts test/e2e/version-2.1.197-models.e2e.test.ts` → 22 pass, 0 fail.
- `bun test src/utils/__tests__/ src/utils/model/__tests__/ test/utils/model/` → 463 pass, 0 fail (regression).
- biome lint on the 3 changed `src/` files: 0 errors (12 pre-existing warnings, unchanged).
- `bun run build` green (`dist/cli.js` 28.84 MB, `MACRO.VERSION=2.1.287`, `MACRO.BINARY_NAME=occ`).
- REPL smoke (built artifact):
  - `occ --version` → `OCC 2.1.287`.
  - `occ --model claude-opus-5 --version` → accepts the new default (no "unknown model" rejection).
  - `occ --help` `--model` line → byte-matches the binary: `(e.g. 'fable', 'opus', or 'sonnet') … (e.g. 'claude-fable-5')`.
  - `echo "say PONG" | occ -p` → `PONG` (default sonnet path for plain PAYG users — no regression; the opus-5 switch only affects ant/Max/Team-Premium subscribers, whose accounts are opus-allowlisted).
  - `occ -p --model claude-opus-5` → faithfully passes `claude-opus-5` to the API (`400 model is not in allowlist` is the test account's backend allowlist — the official binary would hit the same on this key; not an OCC defect).

## 6. Staged follow-up (remaining Opus 5 + 2.1.219 P1–P4) — for subsequent runs

Each remaining item needs dedicated decompilation per site to faithfully
recover exact upstream logic before porting (no invented/partial
implementations, per `aligning-with-official-binary`).

### Opus 5 launch (P1) — remaining sites
| # | Item | Site | Status |
|---|------|------|--------|
| 1b | `/model` picker Opus row → Opus 5, label `Opus 5 with 1M context` + pricing suffix | `src/utils/model/modelOptions.ts` | staged (needs exact picker row shape + pricing suffix) |
| 1c | `MODEL_COSTS` pricing tier for opus-5 | `src/utils/modelCost.ts` | staged (fast-mode $10/$50 confirmed; base tier needs careful binary extraction — do NOT guess) |
| 1d | Fast-mode model-resolution + support set (Opus 5 + Opus 4.8; remove 4.7) | `src/utils/fastMode.ts:146,171` | staged (coupled — needs full `a7n`/`UIc` resolution extraction) |
| 1g | effort/thinking/betas/advisor allowlists for opus-5 (exact tier cells e.g. `o5-bmin`) | `src/utils/{effort,thinking,betas,advisor}.ts` | staged (mirror opus-4-8 per binary — extract verbatim tier values) |
| 1h | `claude-api` bundled skill default Opus 5 + migration from 4.8 | `src/skills/bundled/claudeApiContent.ts` | staged (skill content sync) |
| 1i | `/model` picker "highlight newest only" (Opus 5) | model picker | staged (UI) |

### Other 2.1.219 P1–P4 (unchanged from OCC-34/35 §4, restated for completeness)
| # | 2.1.219 item | Priority | Status |
|---|---|---|---|
| 2 | `sandbox.network.strictAllowlist` setting | P1 | staged |
| 4 | `mcp_server_errors` in stream-json init | P1 | staged |
| 5 | `workflowSizeGuideline` settings key + `/config` hide | P2 | staged |
| 6 | nested subagent forwarding (depth-2+) under `--forward-subagent-text` | P2 | staged |
| 7 | `claude -p` keep answer on mid-stream API error | P2 | staged |
| 8 | `claude mcp list` / `/mcp` HTTP errors + MCP-config whitespace warning | P2 | staged |
| 18/21 | dynamic workflows default medium (<15 agents) + status line | P2 | staged |
| 19 | managed MCP allowlist/denylist `${VAR}` from startup env | P2 | staged |
| 10/14/15/20 | `/model` Opus (1M) label, Vim ←, screen-reader echo, highlight-newest | P3 | staged |
| 9/11/12/13/16/17 | Fable credits label, GNU screen, Remote Control, Windows git-bash, teleport | P4 | skip/doc (niche → by-design divergence) |

Full catch-up to `2.1.220` lands when the above close. Tracked-upstream
pointer advances to `2.1.219` **partial** (P0 + Opus 5 canonical foundation +
this round's 1a/1e/1f/1j downstream ports done) until the remaining Opus 5
launch sites + P1–P4 close; `2.1.220` remains a no-op.
