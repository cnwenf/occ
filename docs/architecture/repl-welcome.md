# REPL Welcome Screen

The OCC REPL opens with a responsive, terminal-native welcome card implemented
by `src/components/LogoV2/OccWelcome.tsx`, with the gradient mark drawn by
`src/components/LogoV2/OccMark.tsx`. It keeps the familiar Claude Code startup
information while giving OCC a distinct, high-tech visual identity.

## Design research

OCC-45 reframed the welcome screen around a "tech" aesthetic. The design
language was assembled from well-known terminal/TUI techniques (studied, not
copied):

- **Diagonal truecolor gradient** across the mark's cells — the multi-line
  gradient approach popularized by `gradient-string`. Color flows from a
  launch gold at the top-left through ember thrust to a signal rose at the
  bottom-right.
- **Low-frequency one-shot light sweep** instead of repainting at the
  terminal's maximum frame rate (the `grok-build` shimmer principle, carried
  over from the earlier design).
- **HUD panel framing** in the style of `btop`/`lipgloss` panels: a title tab
  embedded in the top border, labeled key/value readout rows, a dashed rule,
  and a bullet-prefixed hint line.
- **Block/quadrant silhouettes** rather than ASCII line art, so the mark stays
  crisp across monospace fonts (the `figlet` "ANSI Shadow" lineage reads as
  modern rather than retro).
- **Luma hierarchy** — identity bright, context dim, hint dimmest — so the eye
  lands on the mark first (the `grok-build` top-bar principle).

Earlier rounds (`OCC-18`, `OCC-20`, `OCC-25`) established the underlying
letterform, the per-session tip, and the accessibility fallback. Their records
live in `docs/welcome-page-visual-occ18.md`, `docs/welcome-logo-occ20.md`, and
`docs/welcome-logo-occ25.md`. The OCC-45 redesign rationale and candidate
evaluation are recorded in `docs/welcome-logo-occ45.md`.

**OCC-50 replaced the identity itself**, designed through the `brandkit`
skill in dark-developer mode: three free-form directions (no "OCC"
letterform) were explored as terminal-native block art — "Lodestar" compass
star (rejected: arm imbalance reads as a cross), "Core Frame" viewfinder
(rejected: UI glyph, low ownability), and the selected **"Ascendant"**: a
signal climbing its own trail — scaffold momentum flaring into a spark of
intent at the summit. The OCC-45 rendering engine (gradient, shimmer,
degradation ladder) was kept; only the silhouette and palette changed. Full
boards, rationale, and tier drawings are recorded in
`docs/welcome-logo-occ50.md`.

## Information hierarchy

The card deliberately limits the first screen to four levels:

1. **Identity:** `OCC`, version, and `Open C Code` — embedded in the top border
   as a title tab.
2. **Hero:** the gradient "Ascendant" comet mark with a short readiness
   line (`Ready when you are.`).
3. **Context:** labeled readout rows — `MODEL` (model + billing) and `PROJ`
   (Git branch + cwd, agent-prefixed when present).
4. **Action:** one deterministic, session-stable hint after a dashed rule.

The mark is a pure abstract trajectory — a 45° trail of stepped momentum
flaring into a diamond signal head — deliberately decoupled from any
letterform. Quadrant caps taper the tail and flare the head; the right edge
cascades one column per row so the silhouette reads as a smooth trajectory.
It renders at monumental scale on wide terminals.

## Responsive tiers

`getOccWelcomeMode()` keeps layout decisions deterministic and testable:

| Terminal width | Layout | Behavior |
|---|---|---|
| 76+ columns | Wide hero | Seven-row, 14-column mark beside labeled metadata |
| 44–75 columns | Compact card | Seven-row, 12-column mark stacks above metadata |
| Under 44 columns | Plain | Five-row, 8-column mark, no border, essential text |

The card caps itself at 84 columns so it remains readable in very wide
terminals. All context strings use display-width-aware truncation, including
CJK paths. Screen-reader mode and `TERM=dumb` explicitly force a separate
text-only variant of the plain layout (no mark, no border).

The same mark component (`OccMark`) also replaces the retired doge mascot in
the full-logo path (`LogoV2.tsx`), so both condensed and full startup screens
share one identity.

## Color, motion, and compatibility

- The gradient is theme-aware: the luminous launch ramp (launch gold → ember
  thrust → signal rose) on dark themes and darker saturated stops (deep amber
  → vermilion → crimson rose) on light themes, so every stop keeps at least
  3:1 contrast (the WCAG non-text-graphics threshold) against the reference
  background.
- **Degradation ladder** is automatic via chalk's color-level detection:
  truecolor terminals get the smooth ramp; 256-color terminals get the nearest
  cube colors; 16-color terminals get the nearest basic colors; `NO_COLOR`
  terminals get plain glyphs — the silhouette always survives. Screen-reader
  mode and `TERM=dumb` skip the art entirely.
- The diagonal light sweep runs once for 1.85 seconds at roughly 12 frames per
  second, then settles into the static gradient and unsubscribes from the
  shared animation clock. `prefersReducedMotion` disables it.
- The existing `welcomeTips.ts` picker supplies one deterministic hint per
  session, so the copy does not jump during a re-render.
- `useAnimationFrame` pauses the effect when the card leaves the viewport, so
  it does not keep repainting scrollback.

## Code map

- `src/components/LogoV2/OccMark.tsx` owns the three mark tiers, the gradient
  engine (`sampleGradient`, `markCellT`, `isShimmerCell`), and the one-shot
  shimmer.
- `src/components/LogoV2/CondensedLogo.tsx` gathers live REPL state, including
  the cached Git branch.
- `src/components/LogoV2/OccWelcome.tsx` owns responsive presentation: the HUD
  title tab, labeled readout rows, dashed rule, and tip line.
- `src/components/__tests__/OccWelcome.test.tsx` covers tier boundaries,
  width-normalized art, gradient sampling and contrast, shimmer stability, and
  rendered wide/compact/plain layouts.
- `test/e2e/repl-welcome-visual.e2e.test.ts` boots the built REPL in tmux at
  100, 60, and 36 columns (plus the forced full logo) to verify real terminal
  glyph rendering and that the retired doge no longer appears.
