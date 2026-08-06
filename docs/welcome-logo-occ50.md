# OCC REPL logo redesign — “Monolith Rising” (OCC-50)

> This supersedes the OCC-45 gradient open-C “Ion Aperture” mark (recorded in
> `docs/welcome-logo-occ45.md`). The implementation lives in
> `src/components/LogoV2/OccMark.tsx` (mark + gradient engine) and
> `src/components/LogoV2/OccWelcome.tsx` (HUD card layout). The brandkit
> concept-exploration and identity-system boards for this round are attached
> as images to the OCC-50 issue comment.

## Brief

OCC-50 asks for a second elevation round with two explicit mandates:

1. **Use the brandkit skill** for the design work — strategy first, then
   multi-direction concept exploration, then a single selected identity
   system.
2. **Decouple the mark from the “OCC” letterforms.** Free-form symbol:
   abstract shape, symbol system, or an entirely new visual metaphor. What
   the REPL finally shows is the design’s decision.

The aesthetic baseline stays dark-tech / developer-tool; the startup
information (version, model, cwd, tip) must survive; legacy terminals must
degrade without garbage; reduced motion must disable animation.

## Brand strategy (brandkit step 1)

| Axis | Read |
|---|---|
| Category | Developer tool — terminal coding agent |
| Audience | Terminal-native developers, OSS builders |
| Product function | Reads, writes, builds, and runs from the prompt line |
| Emotional promise | An intelligence that arrives ready to build |
| Cultural position | Open-source, builder-native, precise |
| Symbolic metaphor | The block cursor, scaled to monumental size — a 2001-style monolith standing on the prompt line |
| Avoid | Letterform lockups, the previous fire palette, generic `>_` terminal clichés, mascots |

The product’s native object is the **cursor**: a coding agent *is* a prompt
cursor with agency. Brandkit method fusion: *product action* (prompt → cursor
→ build) × *metaphor* (the monolith as an artifact of intelligence). The mark
is therefore not a letter — it is the agent’s cursor, risen and lit.

## Concept directions (brandkit step 2)

All candidates evaluated as settled silhouettes at the three production
tiers, in the dark-tech register.

### A — “Monolith Rising” (selected)

A quadrant-rounded slab (the cursor-monolith) standing on an underscore
horizon (the prompt line it rises from). Cool plasma gradient flowing
bottom→top: grounded violet base, electric blue body, ice-lit crown. One-shot
ignition sweep rises base→crown and settles.

```text
    ▟████▙
    ██████
    ██████
    ██████
    ██████
    ██████
▄▄▄▄██████▄▄▄▄
```

### B — “Carrier Pulse” (rejected)

The agent as a living signal — an EKG pulse line of eighth-block cells,
phosphor green → cyan. Rejected: busy silhouette, heartbeat cliché, collapses
below five rows.

### C — “Prompt Frame” (rejected)

Targeting caret — corner brackets framing a solid cursor core. Rejected: one
step from the generic `>_` terminal-icon family; bracket strokes thin out at
low rows.

| Criterion | Monolith Rising | Carrier Pulse | Prompt Frame |
|---|---:|---:|---:|
| Tech character | Strong | Medium | Medium |
| Cross-font stability | Strong | Weak | Medium |
| Legibility at 3–5 rows | Strong | Weak | Medium |
| Decoupled from “OCC” letters | Strong | Strong | Medium |
| Ownability | Strong | Weak | Weak |

**Selected: A, “Monolith Rising”.** Tagline: *“The cursor that builds.”*

## Production resources

The silhouette is redrawn at three tiers (same geometry family; the plain
tier trades the rounded crown for a flat top, which is crisper at five rows
and keeps its rendered output distinct from the compact tier’s):

```text
wide · 7 rows × 14 cols       compact · 7 rows × 10 cols    plain · 5 rows × 8 cols
    ▟████▙                       ▟██▙                        ████
    ██████                       ████                        ████
    ██████                       ████                        ████
    ██████                       ████                      ▂▂████▂▂
    ██████                       ████
    ██████                       ████
▄▄▄▄██████▄▄▄▄                ▄▄▄████▄▄▄
```

- Wide (76+ cols): 7×14 monolith beside labeled metadata in a titled HUD card.
- Compact (44–75 cols): 7×10 monolith stacked above metadata in the same card.
- Narrow (<44 cols): 5×8 monolith without a decorative border.
- Screen-reader mode and `TERM=dumb`: text-only, no art, no border.

The same `OccMark` component also serves the full-logo path (`LogoV2.tsx`),
so condensed and full startup screens share one identity.

## Color and motion — cool plasma

The OCC-45 fire family (gold → ember → rose) is retired; the new register is
cold light.

- Dark themes: `rgb(124,58,237)` → `rgb(59,130,246)` → `rgb(103,232,249)`.
- Light themes: `rgb(109,40,217)` → `rgb(29,78,216)` → `rgb(14,116,144)`.
- Gradient parameter per cell: 78% vertical rise (t = 0 at the base, t = 1 at
  the crown) + 22% horizontal, so the slab’s sides catch the light
  asymmetrically.
- Ignition sweep: one rising pass over 1.85 s at an 84 ms cadence;
  highlighted cells blend toward white, then the sweep settles into the
  static gradient. `prefersReducedMotion` disables it.
- Every stop measures ≥ 3:1 against the reference background in its theme
  (WCAG non-text-graphics threshold); the transient highlight carries no
  structural detail.

## Compatibility

- chalk’s color-level ladder down-converts automatically: truecolor → 256 →
  16. The silhouette renders identically at every level (verified in tmux at
  each step — see the acceptance captures on the issue).
- `TERM=dumb` and screen-reader mode force the text-only plain variant; all
  startup information survives.
- The tmux welcome e2e asserts the new signature glyphs per tier and confirms
  the retired doge (`/\___/\`, `=w=`, `~~`) still never appears.

## Acceptance

- Unit tests cover tier boundaries, width-normalized art, per-tier signature
  uniqueness, gradient sampling, rising gradient direction, per-stop
  contrast, the rising ignition sweep, and rendered wide/compact/plain
  layouts.
- The built REPL is captured in tmux at wide/compact/narrow widths, in the
  forced full-logo path, and at the 256-color / 16-color / `TERM=dumb`
  degradation steps; screenshots are attached to the OCC-50 issue together
  with the brandkit concept-exploration and identity-system boards.
