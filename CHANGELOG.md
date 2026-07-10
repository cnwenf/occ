# Changelog

All notable changes to **OCC** (the independent open-source Claude Code–style coding agent) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

OCC tracks upstream Claude Code releases. The baseline catch-up is `2.1.204`;
versions above that are OCC-specific releases. See `.occ-research/` for the
upstream catch-up changelog.

## 2.1.261 - 2026-07-10

- Rebrand `occ --version` to print `OCC <version>` instead of the raw Claude Code version
- Set `MACRO.PACKAGE_URL` to `@cnwenf/occ` so update prompts point at the OCC npm package
- Point `occ update` at `@cnwenf/occ` and fix Bun global install path
- Auto-updater is now notice-only for OCC — it never auto-installs, only notifies on new versions
- Default `includeCoAuthoredBy` to `false` (no `Co-Authored-By` trailer on commits)
- Bump `puppeteer-core` to `^24` for Node 20 compatibility
- Make `update.ts` `spawnSync` monkey-patchable for CI

## 2.1.260 - 2026-07-10

- Add AI-powered `/feedback` command that collects logs + errors and drafts a GitHub issue via a prompt command
- Add rotating JSONL disk error logger with `MAX_ERRORS=20` tail merged into feedback context
- Capture `uncaughtException` + `unhandledRejection` into `logError`
- Tag API errors with `kind:'api'` in `logAPIError` for structured filtering
- Local error capture now works outside the cloud-provider gate

## 2.1.259 - 2026-07-07

- Catch up to Claude Code `2.1.204` — 23 upstream features + docs aligned
- Wire `WorkflowPermissionDialog` + `Ctrl+G` edit-script entry for workflows
- `/background` now backgrounds the live session (mirrors official Claude Code)
- Remove always-false gate so session backgrounding actually works
- Make `APIError` a value import so the retry path doesn't throw `ReferenceError`
- Remove TC39 `using` declarations for Bun `<1.3.14` compatibility

## 2.1.258 - 2026-07-07

- Complete the Workflow engine — real VM sandbox with all primitives + journal + `/workflows` command
- Add workflow UI: progress tree + `/workflows` dialog + permission dialog + result display
- Add `/skills` sort-by-token + `Ctrl+G` editor context + subagent-spawn classifier + did-you-mean suggestions
- Fix `occ -p` hang caused by `KAIROS`/`UDS_INBOX` flags re-enabling blocking subsystems

## 2.1.257 - 2026-07-07

- Add FleetView Phase 2: heartbeat + job actions + group mode + peek-reply + DIAG strip
- Add daemon B6–B12: SSH cold-start + `connectRemoteControl` + background-default + nesting + agent-id + implicit-team + PID namespace
- Add daemon B1–B5: background-agent supervisor + lockfile + worker registry + `ERESPAWN` + CLI
- Fix `grep` to fall back to system `rg` / `grep` when the builtin ripgrep binary is missing
- Add collapsible tool results — `maxHeight` + `e` to expand (aligns with official UX)

## 2.1.256 - 2026-07-07

- Add FleetView Phase 1: inline navigable agent/workflow list below the input
- Add FleetView Phase 3: daemon↔FleetView session bridge
- Add `#10` H4 WebBrowser tool — real implementation via `puppeteer-core` + system Chrome
- Fix `#11` F/I/J trivial gaps + `/plugin` alignment
- Add ultracode-ux: input-box blue+shimmer highlight + persistent top-right effort badge

## 2.1.255 - 2026-07-07

- Add daemon-worker async launch matching official remote CCR
- Retain completed workflows for `/workflows` browsing
- Fix `WorkflowDetailDialog`: flatten `RunLine` to avoid nested `<Text>` in `Select`
- Fix `/goal`: single `metaMessage` + `WorkflowDetailDialog` per-agent rows
- Swap dark/light theme palettes to match official (ultracode badge, etc.)
- Add FleetView `Enter`-to-dispatch + navigable dispatch list (aligns official UX)

## 2.1.254 - 2026-07-07

- Add final alignment batch C9+D5+G2+B7+B2+I14
- Add in-process async (`NO-OP setAppState`) + UX keybindings/commands alignment
- Confirm `F28 CLAUDE_CODE_ENABLE_AUTO_MODE` + `K2` streaming done
- Add 19 alignment fixes: hooks D1-D18 + commands E8-E15 + F23/H14 + I16d/e + A4
- Add 11 alignment fixes: `/stop` `/background` `/daemon` `/update` + C6/C7 + D14/D6 + G3 + I10 + F32
- Add 10 alignment fixes (J4/KB/H5/B11/H13/F27/G7/D9/D10/D16)

## 2.1.253 - 2026-07-07

- Add comprehensive bilingual documentation (EN 20 files + ZH 20 files + README)
- Reorganize docs: `en/` + `zh/` at top level, whitepaper moved to `architecture/`
- Remove old whitepaper directory — to be rewritten per Claude Code structure

## 2.1.252 - 2026-07-07

- Fix `workflow-detail` subtitle: `<Box>` inside Dialog's `<Text>` caused Box-in-Text crash
- Fix `acceptance`: `/goal` status icons + `Workflow scriptPath` optional
- Add `[esc]` dismiss hint to all panel inputGuides

## 2.1.242 - 2026-07-07

- Baseline catch-up version — aligns OCC with Claude Code `2.1.204` feature surface
- 6 live feature flags: `TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`, `MONITOR_TOOL`, `WORKFLOW_SCRIPTS`, `EXPERIMENTAL_SKILL_SEARCH`, `MCP_SKILLS`
- Stubbed/removed: Computer Use, `*-napi` packages, Analytics/GrowthBook/Sentry, Magic Docs, Voice Mode, LSP Server, Plugins/Marketplace
