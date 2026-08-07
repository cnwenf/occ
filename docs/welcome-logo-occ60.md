# OCC REPL logo redesign — "Signal Chevron" (OCC-60)

> Supersedes the OCC-50 "Ascendant" comet mark (recorded in
> `docs/welcome-logo-occ50.md`). The implementation lives in
> `src/components/LogoV2/OccMark.tsx` (mark generator + shimmer engine)
> and `src/components/LogoV2/OccWelcome.tsx` (HUD card layout). The
> OCC-45 HUD card system (title tab, labeled readout rows, dashed rule,
> session tip) and the one-shot shimmer mechanics are carried over;
> OCC-60 replaces the *identity* and the *palette*.

## Brief

Four design directions were presented to the user; the user selected
**direction A — "Signal Chevron"**: the REPL prompt `❯` abstracted into
a braille dot-matrix beam. The design language aligns with the
grok-build welcome screen: near-black canvas (`#0a0a0a`), a dark-grey
dot matrix, and ONE diagonal shimmer highlight sweeping grey →
near-white. **No color gradient** — the OCC-50 gold/ember/rose ramp is
retired in favor of disciplined monochrome.

## Generation formula (canonical)

The mark is generated, not hand-drawn. For a dot grid `W` dots wide and
`H` dots tall with vertical center `cy = (H-1)/2`:

```text
for each dot row y:
    fx = (W - 2) * (1 - |y - cy| / cy)     # beam center x
    light every dot (x, y) with |x - fx| <= radius
```

- The beam apex reaches `x = W-2` at the middle rows and tapers
  linearly to `x = 0` at the top/bottom edges — a right-pointing
  chevron, the prompt gesture.
- The dot grid is packed into Unicode braille: each terminal cell is a
  2×4 dot block, left column bits 0/1/2/6, right column bits 3/4/5/7,
  base code point U+2800. One cell carries four dot rows, so the beam
  stays sub-cell smooth.
- Regenerate — never hand-copy. `generateSignalChevron(spec)` in
  `OccMark.tsx` is the single source of truth; `OCC_MARKS` is built at
  module load and unit-verified against the formula.

The wide tier is the user-confirmed 30×32 grid (`cy = 15.5`,
`radius = 2.1`). Allowed micro-tuning vs. the hand-drawn preview board
was expected: the formula produces a slightly smoother, continuous beam
(the preview was sketched in 4-char braille groups).

## Tiers

One silhouette at three grids (`CHEVRON_SPECS`):

| Tier | Grid (dots) | Radius | Art size | Use |
|---|---|---|---|---|
| wide | 30 × 32 | 2.1 | 8 × ≤15 cells | terminals ≥ 76 columns |
| compact | 26 × 28 | 1.1 (beam −1 dot) | 7 × ≤13 cells | 44–75 columns, full-logo box |
| plain | 20 × 20 | 3.1 (thick beam) | 5 × ≤10 cells | < 44 columns / legacy |

Generated art (module-load output of `OCC_MARKS`):

```text
wide (8 rows)                  compact (7 rows)        plain (5 rows)
⠛⠷⣤⣀                           ⠙⠢⢄⡀                    ⠻⢿⣦⣄⡀
   ⠙⠻⢶⣄⡀                          ⠈⠓⠤⣀                  ⠈⠙⠻⢷⣦⣄⡀
      ⠈⠙⠷⣦⣄                          ⠙⠲⢄⡀                 ⢈⣿⣿⡷
          ⠉⠛⢶⣤⣀                        ⢈⡱⠆             ⢀⣠⣴⡾⠟⠋⠁
          ⣀⣤⠾⠛⠉                     ⣠⠴⠊⠁             ⣴⣾⠟⠋⠁
      ⢀⣠⡶⠟⠋                       ⢀⡤⠒⠉
   ⣠⣴⠾⠋⠁                        ⣠⠔⠊⠁
⣤⡶⠛⠉
```

Every tier is vertically mirror-symmetric by construction
(`|y - cy|`); the unit suite asserts the mirror row-by-row.

## Palette & motion

- **Dark themes:** rest `#5a5a5a` (dark grey matrix), shimmer peak
  `#e1e1e1` (near-white).
- **Light themes:** darker grey variants — rest `#404040`, peak
  `#757575` — so both tones keep ≥ 3:1 contrast (WCAG non-text
  graphics threshold) against the reference background. Unit-verified.
- **Motion:** one diagonal shimmer band sweeps at ~12 fps for 1.8 s,
  then the mark settles at the resting tone and unsubscribes from the
  animation clock (no ongoing repaints). `prefersReducedMotion`
  disables the sweep.

## Degradation ladder

`getMarkColorMode()` gates on `chalk.level`:

| Terminal capability | Rendering |
|---|---|
| 256-color / truecolor (level ≥ 2) | toned matrix + shimmer |
| 16-color (`FORCE_COLOR=1`, level 1) | uncolored silhouette |
| `NO_COLOR` / `TERM=dumb` / non-TTY (level 0) | uncolored silhouette |
| reduced motion (any level) | static, no sweep |
| screen reader | text-only welcome (braille art would be read aloud) |

Below 256-color support the grey tones cannot be honored (rgb() would
quantize to unpredictable basic colors), so the mark falls back to the
terminal's own foreground — the shape always survives, never as
garbled color noise.

## Acceptance (recorded on the OCC-60 issue)

Real tmux captures of the built REPL: wide (100 cols), compact (60),
narrow (36), forced full logo, light theme, `TERM=dumb`, `NO_COLOR`,
16-color — all attached to the issue. Unit suite (generator formula,
mirror symmetry, tone contrast, shimmer stability, color-mode gate,
rendered cards) and the tmux e2e suite are green.
