# OCC-60 — REPL startup logo: "Signal Chevron" (user-selected direction A)

## Background

The user reviewed four design directions for the REPL startup mark and
selected **A. "Signal Chevron"** — the REPL prompt `❯` abstracted as a braille
dot-matrix light beam. The chosen design language aligns with the grok-build
welcome screen: near-black ground (`#0a0a0a`), dark-gray dot matrix, and a
single diagonal shimmer highlight (gray → near-white). **No color gradient.**
It replaces the OCC-50 "Ascendant" comet mark on `main`.

## The mark

A right-pointing chevron built from two mirrored diagonal strokes of lit
braille dots meeting at a right-edge apex. The wide tier (30x32 grid, beam 2.1), exactly as the generator emits it:

```
⠛⠷⣤⣀
   ⠙⠻⢶⣄⡀
      ⠈⠙⠷⣦⣄
          ⠉⠛⢶⣤⣀
          ⣀⣤⠾⠛⠉
      ⢀⣠⡶⠟⠋
   ⣠⣴⠾⠋⠁
⣤⡶⠛⠉
```

## Parametric generation (no hand-copying)

The glyph is generated from a formula, not transcribed, so the silhouette is
optically consistent at every tier:

- Dot grid `dotWidth × dotHeight`, center `cy = (dotHeight - 1) / 2`.
- For each dot row `y`: beam center `fx = (dotWidth - 2) * (1 - |y - cy| / cy)`.
- Light every dot with `|x - fx| <= beam`.
- Pixels → braille: each cell is 2×4 dots; left column bits 0/1/2/6, right
  column bits 3/4/5/7, base U+2800.
- Global bounding-box trim keeps the staggered chevron gesture; blank cells
  become ASCII spaces.

## Tiers (one shape, downsampled)

| Tier | Grid | Beam | Braille rows × cols | Use |
|---|---|---|---|---|
| wide | 30×32 | 2.1 | 8 × 15 | ≥76 columns |
| compact | 24×28 | 1.6 | 7 × 12 | 44–75 columns, full-logo panel |
| plain | 16×20 | 2.4 | 5 × 8 | <44 columns (thick stroke so the silhouette survives) |

## Palette and motion

- **Rest:** flat dark gray `#5a5a5a` (dark themes) / `#3d3d3d` (light themes).
- **Shimmer:** single diagonal band toward `#e1e1e1` (dark) / `#707070`
  (light), one-shot, ~1.8 s at ~12 fps, then the clock unsubscribes and the
  mark settles. `prefersReducedMotion` disables the sweep.
- Every palette state keeps ≥ 3:1 graphical contrast against the reference
  background (WCAG non-text-graphics threshold). No hue is used anywhere —
  the identity is monochrome by design.

## Degradation ladder

- chalk color-level detection: truecolor → 256 → 16 colors down-convert the
  grays; `NO_COLOR` yields plain glyphs. The silhouette always survives.
- `TERM=dumb` / screen-reader: the condensed path renders the text-only
  variant (no braille); the full-logo path renders a small ASCII chevron
  silhouette (`\` / `/` strokes) so nothing mojibakes on legacy terminals.

## Verification

- Unit (`src/components/__tests__/OccWelcome.test.tsx`): tier boundaries,
  generator determinism, braille-run contiguity, vertical beam symmetry,
  user-confirmed top stroke, grayscale + 3:1 contrast, shimmer settle, dumb
  detection, rendered wide/compact/plain/forced-plain layouts.
- tmux e2e (`test/e2e/repl-welcome-visual.e2e.test.ts`): wide / compact /
  narrow / forced full logo / light theme / `TERM=dumb` / 16-color, asserting
  the per-tier braille signatures and the legacy degradation.

Earlier identity rounds: `docs/welcome-logo-occ45.md`,
`docs/welcome-logo-occ50.md`.
