# OCC terminal logo design (OCC-20)

> Historical specification for the retired open-orbit mark. OCC-25 replaces it
> with the single-silhouette aperture documented in
> [`welcome-logo-occ25.md`](welcome-logo-occ25.md).

## Goal

Replace the condensed REPL welcome screen's literal `OCC` ASCII wordmark with a
real icon that belongs to OCC, remains recognizable at several terminal widths,
and preserves the existing one-shot shimmer and Claude Code-compatible
information hierarchy.

The visual technique is informed by grok-build's multi-resolution Braille
assets and low-frequency shimmer. OCC does not copy its source or logo geometry;
each asset below is an original drawing implemented in TypeScript/Ink.

## Mark concept

The mark is an **open orbit**:

- the unfinished outer ring represents open, inspectable tooling;
- the solid center is the code kernel;
- the detached diagonal cell at the opening suggests a terminal cursor moving
  outward.

It intentionally contains no literal `O`, `C`, or `OCC` characters. The product
name remains in the header so the icon does not have to carry version or
descriptive text.

## Multi-resolution assets

The three resources share geometry but are redrawn, not truncated:

| Mode | Width trigger | Asset | Placement |
|---|---:|---|---|
| Wide | 76+ columns | 7-row large mark | Beside metadata |
| Compact | 44–75 columns | 5-row medium mark | Above metadata |
| Plain/narrow | Under 44 columns | 3-row small mark | Above borderless text |

`normalizeLogo()` pads every row to the resource's display width. Layout math
uses `stringWidth()` rather than JavaScript string length, and the shimmer walks
display columns. Those choices keep Braille cells aligned in Ink and prevent a
highlight band from splitting the mark differently from its flex width.

The accessibility fallback is deliberately separate: when screen-reader mode
or `TERM=dumb` forces `plain`, decorative art and animation are omitted. A
normally detected narrow UTF-8 terminal still receives the small mark.

## Motion

All three sizes connect to the same diagonal shimmer:

- one pass over 1.85 seconds;
- an 84 ms frame interval (roughly 12 frames per second);
- base brand color with a brighter highlighted band;
- no animation when reduced motion is requested;
- the shared animation subscription is released after the pass.

This keeps the established OCC-18 motion behavior while making the calculation
resource-aware instead of assuming one fixed wordmark width and height.

## Information hierarchy

The icon only replaces the old hero wordmark. The welcome screen still shows:

1. product name and version;
2. model and billing mode;
3. Git branch, working directory, and optional agent;
4. one stable shortcut tip.

The forced full legacy welcome remains unchanged, including its feed and mascot.

## Acceptance coverage

- Unit tests assert stable width tiers, equal display width for every art row,
  distinct large/medium/small resources, no old wordmark, shimmer preservation,
  and text-only accessibility fallback.
- The tmux REPL test starts the built CLI at 100, 60, and 36 columns and checks
  for the correct asset at each width. It also exercises the forced full
  welcome so the existing information path remains covered.
