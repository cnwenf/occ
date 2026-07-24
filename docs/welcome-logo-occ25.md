# OCC terminal logo redesign (OCC-25)

> This supersedes the OCC-20 open-orbit mark in
> `docs/welcome-logo-occ20.md`. The implementation lives in
> `src/components/LogoV2/OccWelcome.tsx`; responsive layout, shimmer, and the
> accessibility fallback remain intact.

## Brief

OCC-20 combined an unfinished orbit, a code kernel, and a detached cursor. At
only three to seven terminal rows, those ideas became unrelated fragments with
inconsistent visual weight. OCC-25 starts again with one constraint: the mark
must remain a confident silhouette when it is only three rows tall.

## Design study

The redesign uses four practical rules:

1. **One silhouette, one opening.** Adobe's
   [minimalist logo guidance](https://www.adobe.com/uk/creativecloud/design/discover/minimalist-logo-design.html)
   recommends removing detail that muddies at small sizes and treating negative
   space as deliberately as filled space. The new mark therefore has no
   satellite, center glyph, or secondary metaphor.
2. **Grid discipline and consistent weight.** IBM's
   [pictogram guidance](https://www.ibm.com/design/language/iconography/pictograms/design/)
   calls for a stable master grid, consistent strokes, safe exterior padding,
   and optical adjustments at each size. Each OCC resource is redrawn for its
   own grid rather than cropped from the large asset.
3. **Respect terminal cells.** Unicode defines all 256 eight-dot
   [Braille patterns](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-21/)
   on a 2×4 grid but does not prescribe physical glyph dimensions. Braille is
   useful for sketches and fine curves; solid block and quadrant-block cells
   produce the more stable final mass. OCC measures both with `stringWidth()`
   and never depends on a hairline surviving a particular font.
4. **Contrast before decoration.** W3C treats symbolic text glyphs as
   [non-text graphics](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast)
   and uses 3:1 as a useful graphical-object contrast threshold. Although
   logotypes are exempt, OCC keeps the settled silhouette in the established
   base brand token and uses only its brighter companion for transient shimmer.
   Meaning never depends on the second color.

Grok Build remains a useful terminal reference for a single hero mark and a
low-frequency shimmer. Its [changelog](https://x.ai/build/changelog) also
records a legacy Windows welcome-logo rendering fix, reinforcing OCC's separate
text-only fallback. OCC copies neither Grok geometry nor source.

## Candidates

All candidates were evaluated monochrome and without animation.

### A — Solid open C (selected)

```text
▟████████▙
█████████▛
██
██
██
█████████▜
▜████████▛
```

A single rounded C uses one two-cell stroke system and one broad opening. Solid
block mass stays crisp across common fonts, and the opening carries “Open C
Code” without adding another object.

### B — Rounded Braille aperture

```text
   ⢀⣠⣤⣶⣶⣤⣄⡀
 ⢀⣴⣿⣿⡿⠿⠿⢿⣿⣿⣦⡀
 ⣾⣿⡿⠁
⢸⣿⣿⡇
 ⢿⣿⣷⡀
 ⠈⠻⣿⣿⣷⣶⣶⣾⣿⣿⠟⠁
   ⠈⠙⠛⠿⠿⠛⠋⠁
```

The continuous curve has a calm center of gravity and a generous counter, but
its dense dot texture softens under terminal fonts with small Braille dots.

### C — Nested C

```text
   ⢀⣠⣤⣤⣤⣤⣄⡀
 ⢀⣴⡿⠟⠉⣉⣉⠉⠻⢿⣦⡀
 ⣾⡟⠁⣴⡿⠟⠻⢿⣦
 ⣿⡇⢸⣿⡁
 ⢿⣧⡀⠻⣷⣦⣴⣾⠟
 ⠈⠻⣷⣦⣀⣉⣉⣀⣴⣾⠟⠁
   ⠈⠙⠛⠛⠛⠛⠋⠁
```

The concentric Cs make the initials more explicit, but the inner mark
reintroduces competing hierarchy and fragile small detail.

| Criterion | Solid C | Braille aperture | Nested C |
|---|---:|---:|---:|
| Three-row recognition | Strong | Strong | Weak |
| Consistent apparent weight | Strong | Medium | Medium |
| Clean negative space | Strong | Strong | Weak |
| Cross-font stability | Strong | Medium | Weak |

**Selected: A, the solid open C.** It is the only candidate that preserves its
weight, opening, and identity at three rows without a second element.

## Production resources

The selected form is optically redrawn at every responsive tier:

```text
wide · 7 rows      compact · 5 rows   narrow · 3 rows

▟████████▙          ▟██████▙           ▟████▙
█████████▛          ██                 ██
██                  ██                 ▜████▛
██                  ██
██                  ▜██████▛
█████████▜
▜████████▛
```

- Wide terminals (76+ columns) place the 7×10 mark beside metadata.
- Compact terminals (44–75 columns) center the 5×8 mark above metadata.
- Narrow UTF-8 terminals use the 3×6 mark without a decorative border.
- Screen-reader mode, explicit plain mode, and `TERM=dumb` omit decorative art
  and animation entirely.

Every occupied row is a single contiguous run, and all strokes are two cells
thick. Quadrant-block corners (`▟▙▜▛`) soften the exterior and bar terminals so
the shape reads as a letterform rather than a square bracket.

## Motion and color

- base silhouette: `claude`;
- moving highlight: `claudeShimmer`, bold;
- one diagonal pass over 1.85 seconds at an 84 ms cadence;
- animation disabled for reduced motion;
- the settled mark is monochrome and the base token measures at least 3:1
  against the reference white/black backgrounds in light and dark themes. The
  lighter shimmer is transient decoration and carries no structural detail.

## Acceptance

- Unit tests confirm normalized display widths, distinct resources, one
  contiguous occupied run per row, stable shimmer text, light/dark contrast,
  and the forced text-only path.
- Static Ink renders fit 100, 60, and 36 display columns.
- The built `occ` REPL is captured in tmux at those widths with the expected
  resource, no replacement characters, and no torn alignment.
- Both the default dark theme and a light theme preserve the complete
  silhouette after shimmer settles.
