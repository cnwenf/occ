# OCC REPL logo redesign — "Ascendant" (OCC-50)

> Supersedes the OCC-45 "Ion Aperture" open-C mark (recorded in
> `docs/welcome-logo-occ45.md`). The implementation lives in
> `src/components/LogoV2/OccMark.tsx` (mark + gradient engine) and
> `src/components/LogoV2/OccWelcome.tsx` (HUD card layout). The rendering
> engine (diagonal truecolor ramp, one-shot shimmer, degradation ladder)
> is carried over unchanged from OCC-45; OCC-50 replaces the *identity*.

## Brief

User feedback after OCC-45: raise the bar again, and this round **design
with the brandkit skill** and **decouple the mark from the "OCC" letters
entirely** — free-form brand concepting (abstract symbol, symbol system,
or a new visual metaphor), keeping the tech aesthetic and the startup
information (version, model, cwd, tip) intact.

## Brand strategy (brandkit, dark-developer mode)

- **Category:** developer tool — a terminal-native AI coding agent.
- **Audience:** developers who live in the terminal.
- **Emotional promise:** an intelligence that builds with you, session
  after session.
- **Symbol logic:** fuse the AI-assistant family (spark, orbit, signal,
  path) with the builder family (cursor, frame, scaffold, grid).
- **Avoid:** letterforms of the product name, generic AI sparkles,
  lightning bolts, dashboard chart clichés.

## Directions explored

Three directions were drawn as terminal-native block/quadrant art and
evaluated on rendered boards (the boards are attached to the OCC-50
issue as PNGs; the source boards live with the design run).

### A — "Lodestar" (rejected)

A four-point compass star: guidance, the intelligence that orients the
build. Palette ice-cyan → electric cyan → indigo.

```text
      ▗█▖
     ▟███▙
     █████
▄▄▄▄▄█████▄▄▄▄▄
▀▀▀▀▀█████▀▀▀▀▀
     ▜███▛
      ▝█▘
```

Rejection: at 7 terminal rows the arm weights are imbalanced (thick
vertical beam, one-row horizontal beam) and the silhouette reads as a
plus / medical cross. Guidance is also a weaker product truth than
building.

### B — "Core Frame" (rejected)

Viewfinder brackets holding a diamond core: precision, the agent keeps
your intent centered. Palette seafoam → teal → deep teal.

```text
▛▀▀▀▀    ▀▀▀▀▀▜
▌      ▗▖      ▐
▌     ▟██▙     ▐
▌    ▟████▙    ▐
▌    ▜████▛    ▐
▌     ▜██▛     ▐
▙▄▄▄▄▄    ▄▄▄▄▄▟
```

Rejection: crisp and instrument-like, but the viewfinder is a UI glyph,
not an ownable brand mark; the internal gaps also make it the most
fragile tier at small sizes.

### C — "Ascendant" (selected)

A signal climbing its own trail: scaffold momentum (one completed step
per trail row) flaring into a spark of intent at the summit. Palette
launch gold → ember thrust → signal rose.

```text
           ▄▄
          ▟██▙
        ▟████▛
      ▟████▛
    ▟████▛
  ▟████▛
▟████▛
```

Selection: the strongest energy and gradient flow of the three, a
metaphor that is true to a *builder* (momentum, ascent, launch), fully
abstract (no letterform), and block-native — every cell is a solid
block or quadrant, so the silhouette is font-stable. The first draw
("filled steps + tiny beacon") read as a bar chart; the refinement to a
45° comet trail with a cascading right edge and flared diamond head
removed the chart reading while keeping the stepped momentum.

## The final system

- **Name:** Ascendant. Tagline: *"Every session, upward."*
- **Tiers:** wide 7 × 14 (monumental), compact 7 × 12 (trail curves —
  step 2 then 1 — so the launch accelerates at small scale), plain 5 × 8
  (narrow borderless startup). Same gesture redrawn optically per tier.
- **Palette:** dark `#fcd34d → #fb923c → #f43f5e`; light `#b45309 →
  #c2410c → #9f1239` (every stop ≥ 3:1 contrast against the reference
  background — asserted in `OccWelcome.test.tsx`).
- **Rendering:** unchanged OCC-45 engine — per-cell diagonal gradient,
  one-shot 1.85 s light sweep at ~12 fps (reduced motion disables it),
  chalk color-level degradation (truecolor → 256 → 16 → monochrome
  glyphs), `TERM=dumb` / screen reader skip the art entirely.
- **Card:** the HUD card (title tab, MODEL/PROJ readout rows, dashed
  rule, session-stable tip) is untouched — only the hero mark and the
  palette changed, so the information hierarchy validated in OCC-45
  carries over.

## Verification

- Unit: `src/components/__tests__/OccWelcome.test.tsx` (tier
  boundaries, width-normalized art, gradient sampling and contrast,
  shimmer stability, rendered wide/compact/plain layouts).
- Real REPL: `test/e2e/repl-welcome-visual.e2e.test.ts` boots the built
  CLI in tmux at 100 / 60 / 36 columns plus the forced full logo and
  asserts the per-tier signature glyphs and the absence of the retired
  doge and old wordmark.
- Visual acceptance screenshots (wide/narrow, condensed/full, light,
  monochrome) were captured from a live tmux session and attached to
  the OCC-50 issue together with the exploration boards.
