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
original ASCII artwork and copy. No grok-build source or logo asset is copied.

## Information hierarchy

The card deliberately limits the first screen to four levels:

1. **Identity:** `OCC`, version, and `Open C Code`.
2. **Hero:** an ASCII OCC wordmark with a short readiness line.
3. **Context:** model/billing, Git branch, agent name, and cwd.
4. **Action:** one deterministic, session-stable command or shortcut hint.

The previous condensed startup view showed a small mascot next to
model/billing/cwd. It did not expose the Git branch or a useful first action,
and its inherited pose animation had no visible effect because OCC's mascot was
static.

## Responsive tiers

`getOccWelcomeMode()` keeps layout decisions deterministic and testable:

| Terminal width | Layout | Behavior |
|---|---|---|
| 76+ columns | Wide hero | Wordmark and metadata render side by side |
| 44–75 columns | Compact card | Wordmark stacks above metadata |
| Under 44 columns | Plain | No border or decorative art; essential text only |

The card caps itself at 84 columns so it remains readable in very wide
terminals. All context strings use display-width-aware truncation, including
CJK paths.

## Motion and compatibility

- The diagonal shimmer runs once for 1.85 seconds at roughly 12 frames per
  second, then unsubscribes from the shared animation clock.
- The existing `welcomeTips.ts` picker supplies one deterministic hint per
  session, so the copy does not jump during a re-render.
- `prefersReducedMotion` disables the shimmer.
- Screen-reader mode and `TERM=dumb` use the plain layout, with no border,
  decorative ASCII art, or animation.
- The animated logo contains ASCII characters only, avoiding Braille/block
  glyph failures on legacy fonts.
- `useAnimationFrame` pauses the effect when the card leaves the viewport, so
  it does not keep repainting scrollback.

## Code map

- `src/components/LogoV2/CondensedLogo.tsx` gathers live REPL state, including
  the cached Git branch.
- `src/components/LogoV2/OccWelcome.tsx` owns responsive presentation and the
  one-shot shimmer.
- `src/components/__tests__/OccWelcome.test.tsx` covers tier boundaries,
  width-aware context, shimmer stability, and rendered wide/compact/plain
  layouts.
