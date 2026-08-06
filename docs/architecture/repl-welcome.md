# REPL Welcome Screen

The OCC REPL opens with a responsive, terminal-native welcome card implemented
by `src/components/LogoV2/OccWelcome.tsx`, with the gradient mark drawn by
`src/components/LogoV2/OccMark.tsx`. It keeps the familiar Claude Code startup
information while giving OCC a distinct, high-tech visual identity.

The current identity is the OCC-50 **“Monolith Rising”** mark — designed with
the **brandkit skill** (strategy → multi-direction concept exploration →
selected identity system) and deliberately decoupled from the “OCC”
letterforms. Its exploration process, candidate evaluation, and final brand
system are recorded in `docs/welcome-logo-occ50.md`; the brandkit concept and
identity boards are attached to the OCC-50 issue.

## Design research

OCC-50 ran a brandkit dark-tech session. Three directions were explored —
“Monolith Rising” (the block cursor scaled to monumental size, standing on
the prompt line), “Carrier Pulse” (an eighth-block EKG signal line), and
“Prompt Frame” (corner brackets around a cursor core). The monolith won on
tech character, cross-font stability, small-size legibility, and ownability;
the full evaluation matrix lives in `docs/welcome-logo-occ50.md`.

The techniques the winning system re-implements (researched from terminal/TUI
practice, originally implemented, nothing copied):

- **Vertical truecolor gradient** across the mark's cells — the multi-line
  gradient approach popularized by `gradient-string`. Color rises from a
  grounded violet at the base through electric blue to an ice-cyan crown
  ("first light on the monolith").
- **Low-frequency one-shot ignition sweep** instead of repainting at the
  terminal's maximum frame rate (the `grok-build` shimmer principle): a light
  band rises base→crown once and settles.
- **HUD panel framing** in the style of `btop`/`lipgloss` panels: a title tab
  embedded in the top border, labeled key/value readout rows, a dashed rule,
  and a bullet-prefixed hint line.
- **Block/quadrant silhouettes** rather than ASCII line art, so the mark stays
  crisp across monospace fonts (the `figlet` "ANSI Shadow" lineage reads as
  modern rather than retro). The monolith stands on an underscore horizon —
  a half/quarter-block course that reads as ground, not figure.
- **Luma hierarchy** — identity bright, context dim, hint dimmest — so the eye
  lands on the mark first (the `grok-build` top-bar principle).

Earlier rounds established the underlying machinery and are recorded in
`docs/welcome-page-visual-occ18.md`, `docs/welcome-logo-occ20.md`,
`docs/welcome-logo-occ25.md` (open-C letterform), and
`docs/welcome-logo-occ45.md` (the gradient/HUD transformation this round
builds on; its fire palette and open-C silhouette are superseded).

## Information hierarchy

The card deliberately limits the first screen to four levels:

1. **Identity:** `OCC`, version, and `Open C Code` — embedded in the top border
   as a title tab.
2. **Hero:** the gradient monolith mark with a short readiness line
   (`Ready when you are.`).
3. **Context:** labeled readout rows — `MODEL` (model + billing) and `PROJ`
   (Git branch + cwd, agent-prefixed when present).
4. **Action:** one deterministic, session-stable hint after a dashed rule.

The mark is a pure symbol, not a wordmark: the product name stays in the HUD
title tab while the hero glyph is the monolith at monumental scale on wide
terminals.

## Responsive tiers

`getOccWelcomeMode()` keeps layout decisions deterministic and testable:

| Terminal width | Layout | Behavior |
|---|---|---|
| 76+ columns | Wide hero | Seven-row, 14-column monolith beside labeled metadata |
| 44–75 columns | Compact card | Seven-row, 10-column monolith stacks above metadata |
| Under 44 columns | Plain | Five-row, 8-column monolith, no border, essential text |

The card caps itself at 84 columns so it remains readable in very wide
terminals. All context strings use display-width-aware truncation, including
CJK paths. Screen-reader mode and `TERM=dumb` explicitly force a separate
text-only variant of the plain layout (no mark, no border).

The same mark component (`OccMark`) also replaces the retired doge mascot in
the full-logo path (`LogoV2.tsx`), so both condensed and full startup screens
share one identity.

## Color, motion, and compatibility

- The gradient is theme-aware: cool plasma stops on dark themes (violet
  `rgb(124,58,237)` → blue `rgb(59,130,246)` → ice cyan `rgb(103,232,249)`)
  and darker saturated stops on light themes (violet 700 → blue 700 →
  cyan 800), so every stop keeps at least 3:1 contrast (the WCAG non-text-
  graphics threshold) against the reference background. The gradient flows
  bottom→top: 78% vertical rise + 22% horizontal.
- **Degradation ladder** is automatic via chalk's color-level detection:
  truecolor terminals get the smooth ramp; 256-color terminals get the nearest
  cube colors; 16-color terminals get the nearest basic colors — the
  silhouette always survives. Screen-reader mode and `TERM=dumb` skip the art
  entirely.
- The rising light sweep runs once for 1.85 seconds at roughly 12 frames per
  second, then settles into the static gradient and unsubscribes from the
  shared animation clock. `prefersReducedMotion` disables it.
- The existing `welcomeTips.ts` picker supplies one deterministic hint per
  session, so the copy does not jump during a re-render.
- `useAnimationFrame` pauses the effect when the card leaves the viewport, so
  it does not keep repainting scrollback.

## Code map

- `src/components/LogoV2/OccMark.tsx` owns the three monolith tiers, the
  gradient engine (`sampleGradient`, `markCellT`, `isShimmerCell`), and the
  one-shot ignition sweep.
- `src/components/LogoV2/CondensedLogo.tsx` gathers live REPL state, including
  the cached Git branch.
- `src/components/LogoV2/OccWelcome.tsx` owns responsive presentation: the HUD
  title tab, labeled readout rows, dashed rule, and tip line.
- `src/components/__tests__/OccWelcome.test.tsx` covers tier boundaries,
  width-normalized art, per-tier signature uniqueness, gradient sampling and
  contrast, rising gradient and sweep direction, and rendered
  wide/compact/plain layouts.
- `test/e2e/repl-welcome-visual.e2e.test.ts` boots the built REPL in tmux at
  100, 60, and 36 columns (plus the forced full logo) to verify real terminal
  glyph rendering and that the retired doge no longer appears.
