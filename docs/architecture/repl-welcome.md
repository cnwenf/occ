# REPL Welcome Screen

The OCC REPL opens with a responsive, terminal-native welcome card implemented
by `src/components/LogoV2/OccWelcome.tsx`. It keeps the familiar Claude Code
startup information while giving OCC a distinct visual identity.

## Design research

The design was informed by the Apache-2.0 `xai-org/grok-build` welcome screen
(source snapshot `a5727c5960452e7527a154b25cb5bf00cda0545e`), especially:

- `views/welcome/logo.rs`: low-frequency, time-based shimmer instead of
  repainting at the terminal's maximum frame rate.
- `views/welcome/top_bar.rs`: branch and working-directory context is useful at
  startup and should be visually quieter than the product identity.
- `views/welcome/hero_box.rs`: a soft border and a strong two-column hierarchy
  work well on wide terminals.
- `xai-grok-pager-minimal/src/welcome.rs`: compact layouts should retain the
  version, cwd, model, and a single command hint.

OCC reimplements those ideas in its own TypeScript/Ink architecture and uses
original artwork and copy. No grok-build source or logo asset is copied. The
OCC-20 mark and its sizing decisions are recorded in
`docs/welcome-logo-occ20.md`.

## Information hierarchy

The card deliberately limits the first screen to four levels:

1. **Identity:** `OCC`, version, and `Open C Code`.
2. **Hero:** OCC's open-orbit icon with a short readiness line.
3. **Context:** model/billing, Git branch, agent name, and cwd.
4. **Action:** one deterministic, session-stable command or shortcut hint.

The icon is not a rendering of the letters `OCC`. It combines an unfinished
orbit, a central code kernel, and a detached cursor spark. The same geometry is
redrawn at three resolutions instead of mechanically cropped or scaled.

## Responsive tiers

`getOccWelcomeMode()` keeps layout decisions deterministic and testable:

| Terminal width | Layout | Behavior |
|---|---|---|
| 76+ columns | Wide hero | Seven-row large mark and metadata render side by side |
| 44–75 columns | Compact card | Five-row medium mark stacks above metadata |
| Under 44 columns | Plain | Three-row small mark, no border, essential text |

The card caps itself at 84 columns so it remains readable in very wide
terminals. All context strings use display-width-aware truncation, including
CJK paths. Screen-reader mode and `TERM=dumb` explicitly force a separate
text-only variant of the plain layout.

## Motion and compatibility

- The diagonal shimmer runs once for 1.85 seconds at roughly 12 frames per
  second, then unsubscribes from the shared animation clock.
- The existing `welcomeTips.ts` picker supplies one deterministic hint per
  session, so the copy does not jump during a re-render.
- `prefersReducedMotion` disables the shimmer.
- Screen-reader mode and `TERM=dumb` use the forced plain layout, with no
  border, decorative art, or animation.
- Normal UTF-8 terminals render the mark with single-cell Braille and block
  characters. The three resources are display-width normalized before render,
  preventing ragged flex sizing and shimmer seams.
- `useAnimationFrame` pauses the effect when the card leaves the viewport, so
  it does not keep repainting scrollback.

## Code map

- `src/components/LogoV2/CondensedLogo.tsx` gathers live REPL state, including
  the cached Git branch.
- `src/components/LogoV2/OccWelcome.tsx` owns responsive presentation and the
  three logo resources plus the one-shot shimmer.
- `src/components/__tests__/OccWelcome.test.tsx` covers tier boundaries,
  width-normalized art, width-aware context, shimmer stability, and rendered
  wide/compact/plain layouts.
- `test/e2e/repl-welcome-visual.e2e.test.ts` boots the built REPL in tmux at
  100, 60, and 36 columns to verify real terminal glyph rendering.
