# OCC REPL logo redesign — "Ion Aperture" (OCC-45)

> This supersedes the OCC-25 solid open-C mark (recorded in
> `docs/welcome-logo-occ25.md`). The implementation lives in
> `src/components/LogoV2/OccMark.tsx` (mark + gradient engine) and
> `src/components/LogoV2/OccWelcome.tsx` (HUD card layout).

## Brief

Two rounds of welcome-page polish (OCC-18, PRs #197/#198) shipped a two-tone
ASCII doge and then a solid open-C block mark. User acceptance feedback on the
result was blunt: the logo **still has no tech feel and looks bad** — it needs
a redesign, not another tweak. OCC-45 therefore starts from a single explicit
requirement: **strong, unmistakable "tech" character**, while keeping the
startup information (version, model, cwd, tip) intact.

## Design language researched

The redesign studies how established terminal/TUI tools produce a tech
aesthetic, and re-implements the techniques originally — no project code or
artwork is copied:

1. **Diagonal truecolor gradient.** The `gradient-string` multi-line technique:
   interpolate a multi-stop palette across a mark's cells so color flows
   diagonally. This is the single highest-leverage "tech" transformation — flat
   monochrome reads as plain, a smooth spectral ramp reads as energy/modern.
2. **One-shot low-frequency light sweep.** `grok-build`'s shimmer principle: a
   bright band passes over the mark once at ~12 fps and settles, rather than a
   distracting max-frame-rate loop. Reduced-motion users get the static mark.
3. **HUD panel framing.** `btop`/`lipgloss` panel language: a title tab embedded
   in the top border, uppercase micro-labels with key/value readout rows, a
   dashed separator, and a bullet-prefixed hint. This reads as a "console/heads-
   up display" instead of a plain box.
4. **Block/quadrant silhouettes over ASCII line art.** The `figlet` "ANSI
   Shadow" lineage: solid block and quadrant cells hold a crisp silhouette in
   every monospace font and read as modern; `/\___/\` line art reads as retro.
5. **Monumental scaling.** The mark scales up on wide terminals so it has real
   presence rather than sitting as a small icon.
6. **Luma hierarchy.** Identity bright, context dim, hint dimmest — importance
   is encoded in luminance (`grok-build` top-bar principle).
7. **Degradation ladder.** Truecolor → 256 → 16 → monochrome glyphs → text-only
   (`TERM=dumb` / screen reader). chalk's color-level detection handles the
   first four automatically; the art only depends on block/quadrant glyphs.

## Candidates

All candidates were evaluated as settled (post-animation) silhouettes.

### A — Gradient open-C "Ion Aperture" (selected)

Keep the validated OCC-25 open-C silhouette (two-cell stroke, quadrant-rounded
corners, open right side) and transform it with a diagonal truecolor gradient
(solar gold → ember → ion rose) plus HUD framing. Monumental 14-column tier on
wide terminals.

```text
▟████████████▙
█████████████▛
██
██
██
█████████████▜
▜████████████▛
```

Rationale: the letterform was never the complaint — finish was. Gradient + HUD
+ hierarchy deliver the tech character with zero legibility risk, because the
silhouette and its cross-font stability were already proven by OCC-25.

### B — Braille aperture (rejected)

A continuous-curve C drawn from 2×4 Braille cells (revisiting the OCC-20
approach). Rejected: Braille dot size/spacing is not prescribed by Unicode and
softens or misaligns in common terminal fonts; the dense dot texture fights the
"crisp energy" goal. Blocks are the more stable carrier for the gradient.

### C — Circuit-board C (rejected)

A C overlaid with trace/notch details and node dots to evoke a PCB. Rejected:
at 5–7 terminal rows the trace detail collapses into noise; the metaphor does
not survive the size the welcome screen allows.

| Criterion | Gradient open-C | Braille aperture | Circuit C |
|---|---:|---:|---:|
| Tech character | Strong | Medium | Medium |
| Cross-font stability | Strong | Weak | Weak |
| Legibility at 3–5 rows | Strong | Medium | Weak |
| Degradation to 16/256 color | Strong | Strong | Medium |

**Selected: A, the gradient open-C "Ion Aperture".**

## Production resources

The silhouette is redrawn at three tiers (width differs, geometry family is
consistent):

```text
wide · 7 rows × 14 cols     compact · 7 rows × 10 cols   plain · 5 rows × 8 cols
▟████████████▙               ▟████████▙                   ▟██████▙
█████████████▛               █████████▛                   ██
██                           ██                           ██
██                           ██                           ██
██                           ██                           ▜██████▛
█████████████▜               █████████▜
▜████████████▛               ▜████████▛
```

- Wide (76+ cols): 7×14 mark beside labeled metadata in a titled HUD card.
- Compact (44–75 cols): 7×10 mark stacked above metadata in the same card.
- Narrow (<44 cols): 5×8 mark without a decorative border.
- Screen-reader mode and `TERM=dumb`: text-only, no art, no border.

## Color and motion

- Dark themes: `rgb(255,199,110)` → `rgb(255,116,64)` → `rgb(233,60,136)`.
- Light themes: `rgb(181,110,0)` → `rgb(194,62,24)` → `rgb(162,22,82)`.
- Gradient parameter per cell: 72% horizontal + 28% vertical, so color flows
  down the spine as well as across the bars.
- Light sweep: one diagonal pass over 1.85 s at an 84 ms cadence; highlighted
  cells blend toward white and bold, then settle to the static gradient.
- Every stop measures ≥ 3:1 against the reference background in its theme
  (WCAG non-text-graphics threshold); the transient highlight carries no
  structural detail.
- Reduced motion disables the sweep; the settled gradient remains.

## Compatibility

- chalk's color-level detection down-converts automatically: truecolor → 256
  → 16 → none. The silhouette renders identically at every level.
- `TERM=dumb` and screen-reader mode force the text-only plain variant.
- The tmux welcome e2e asserts the mark glyphs and confirms the retired doge
  (`/\___/\`, `=w=`, `~~`) no longer appears in any path.

## Acceptance

- Unit tests cover tier boundaries, width-normalized art, gradient sampling,
  per-stop contrast, shimmer settle, and rendered wide/compact/plain layouts.
- The built REPL is captured in tmux at wide/compact/narrow widths and in the
  forced full-logo path; screenshots are attached to the OCC-45 issue.
