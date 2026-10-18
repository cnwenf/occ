# Upstream Version Gap — OCC-162 Round (2026-10-19): strict self-acceptance vs official 2.1.302

> Status: **IN PROGRESS** — no official version gap (2.1.302 aligned in v2.1.388/389). Per the issue's "版本追齐后的自验收" clause: strict self-acceptance A/B round, prioritizing the newest ported surface (2.1.302 PORT ×12 + acceptance-fix ×12).
> Prior-round ledgers: [occ120-2026-10](./upstream-version-gap-occ120-2026-10.md) (2.1.302 PORT round + acceptance-fix round), [occ160-2026-10](./upstream-version-gap-occ160-2026-10.md), [occ157-2026-10](./upstream-version-gap-occ157-2026-10.md), [occ156-2026-10](./upstream-version-gap-occ156-2026-10.md)
> Skill discipline: `upstream-tracking` + `aligning-with-official-binary`. Official binary: forensics only (`strings` / `grep -aboF` / bounded `dd`); uvx official may be run for interaction evidence per issue's uvx-consistency clause — no sensitive data fed.

## 1. Baseline (verified 2026-10-19, this run)

| Item | Value |
|---|---|
| OCC main HEAD | `010116ee` == tag `v2.1.389` (worktree clean at checkout) |
| Build | green — `dist/cli.js` 30.29 MB, MACRO.VERSION=2.1.389 injected |
| Official npm dist-tags (this run) | `latest = next = 2.1.302`, `stable = 2.1.292` |
| STAGED re-review trigger (`stable ≥ 2.1.296`) | **NOT fired** — STAGED set carries as-is |
| Work branch | `agent/occ/17882c36` |

## 2. Self-acceptance ① — 2.1.302 PORT ×12 surface

(TBD — filled as checks land)

## 3. Self-acceptance ② — acceptance-fix ×12 findings re-verification

(TBD)

## 4. Self-acceptance ③ — core trunk spot-checks

(TBD)

## 5. Carryover dispositions

(TBD)

## 6. Full suite + e2e record

(TBD)

## 7. Merge / handoff record

(TBD)
