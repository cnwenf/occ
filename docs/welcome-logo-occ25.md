# OCC terminal logo redesign (OCC-25)

> This supersedes the OCC-20 "open-orbit" mark in `docs/welcome-logo-occ20.md`.
> The implementation lives in `src/components/LogoV2/OccWelcome.tsx`; the
> responsive layout, shimmer, and accessibility fallback described in OCC-20
> are unchanged — only the art asset and its rationale changed.

## Why redesign

OCC-20 shipped an "open orbit": an unfinished outer ring + a solid code kernel
+ a detached diagonal cursor spark at the opening. In practice it read as three
stacked metaphors rendered in dense Braille dots:

- the speckled dot texture blurred on common terminals at small sizes;
- the three-piece composition (ring · kernel · spark) felt fragmented, with no
  single dominant form;
- stroke weight was inconsistent (the spark is one cell, the ring is two-cell,
  the kernel is a fill), so nothing read as one confident mark.

OCC-25 keeps exactly one metaphor and draws it as one clean silhouette.

## The new mark: an open C

A single bold, rounded **C** — the C of "Open C Code" and the C language the
project is built on. It is the only element on the mark.

Design principles applied:

- **One metaphor, one silhouette.** No kernel, no separate cursor spark. The C
  carries the brand alone; the product name stays in the header text where
  version and tagline already live.
- **Consistent stroke weight.** Every tier is a 2-cell-thick stroke. There is
  no thin accent breaking the silhouette — the thing the OCC-20 spark did
  worst.
- **Open on the right.** The right side is deliberately incomplete, which is
  the "open" in Open C Code. The opening is the negative space, not a second
  glyph.
- **Rounded corners, not a square bracket.** The four outer corners and the
  two bar-end inner corners are rounded with quadrant/half-block cells
  (`▟▙▜▛`) so the form reads as a letterform, not `[` or a chunky bracket.
- **Solid block fills, not Braille dots.** Full and half blocks (`█ ▀ ▄`)
  produce a solid silhouette that stays crisp at small sizes and across
  font/terminal variation, instead of speckling into noise.

## Multi-resolution assets

The three tiers share geometry but are redrawn, not scaled:

| Mode | Width trigger | Asset | Top-row signature glyph |
|---|---:|---|---|
| Wide | 76+ columns | 7-row × 10-col C | `▟████████▙` |
| Compact | 44–75 columns | 5-row × 8-col C | `▟██████▙` |
| Plain/narrow | under 44 columns | 3-row × 6-col C | `▟████▙` |

The consecutive-block run length (8 / 6 / 4) is unique per tier, so the e2e
signature-glyph checks never match a wider tier inside a narrower pane.

`normalizeLogo()` still pads every row to the resource's display width, and
layout math still uses `stringWidth()` so block cells stay aligned in Ink.

## Motion

Unchanged from OCC-20: one 1.85s diagonal shimmer pass, 84 ms frame interval,
base brand color with a brighter highlighted band, no animation under reduced
motion, subscription released after the pass. Because the shimmer walks display
columns and only flips color/bold (never drops glyphs), the solid C stays
intact through the sweep.

## Information hierarchy

Unchanged. The icon replaces only the hero art; the welcome screen still shows
product name + version, model + billing, git/working-directory/agent context,
and one stable shortcut tip. The forced full legacy welcome (doge mascot +
feed) is untouched.

## Acceptance coverage

- Unit (`src/components/__tests__/OccWelcome.test.tsx`): stable width tiers,
  equal display width per row, distinct wide > compact > plain row counts, no
  `OCC` substring, no legacy `___   ___   ___` wordmark, shimmer preserves the
  art and settles without highlights, and per-tier art appears at 100/60/36
  columns — all green.
- Real REPL tmux e2e (`test/e2e/repl-welcome-visual.e2e.test.ts`): boots the
  built `dist/cli.js` inside tmux at 100, 60, and 36 columns and asserts the
  correct tier's signature glyph renders at each width with no overflow, plus
  the forced full-logo path — 4/4 pass.
- `bunx biome lint` clean on changed files; `bun run build` green.
