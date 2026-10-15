import { c as _c } from "react/compiler-runtime";
import type { ReactNode } from 'react';
import React, { useContext } from 'react';
import Text from '../../ink/components/Text.js';
import type { Color, Styles } from '../../ink/styles.js';
import { getTheme, type Theme } from '../../utils/theme.js';
import { useTheme } from './ThemeProvider.js';

/** Colors uncolored ThemedText in the subtree. Precedence: explicit `color` >
 *  this > dimColor. Crosses Box boundaries (Ink's style cascade doesn't). */
export const TextHoverColorContext = React.createContext<keyof Theme | undefined>(undefined);
export type Props = {
  /**
   * Change text color. Accepts a theme key or raw color value.
   */
  readonly color?: keyof Theme | Color;

  /**
   * Same as `color`, but for background. Must be a theme key.
   */
  readonly backgroundColor?: keyof Theme;

  /**
   * Dim the color using the theme's inactive color.
   * This is compatible with bold (unlike ANSI dim).
   */
  readonly dimColor?: boolean;

  /**
   * Make the text bold.
   */
  readonly bold?: boolean;

  /**
   * Make the text italic.
   */
  readonly italic?: boolean;

  /**
   * Make the text underlined.
   */
  readonly underline?: boolean;

  /**
   * Make the text crossed with a line.
   */
  readonly strikethrough?: boolean;

  /**
   * Inverse background and foreground colors.
   */
  readonly inverse?: boolean;

  /**
   * This property tells Ink to wrap or truncate text if its width is larger than container.
   * If `wrap` is passed (by default), Ink will wrap text and split it into multiple lines.
   * If `truncate-*` is passed, Ink will truncate text instead, which will result in one line of text with the rest cut off.
   */
  readonly wrap?: Styles['textWrap'];
  readonly children?: ReactNode;
};

/**
 * Resolves a color value that may be a theme key to a raw Color.
 */
function resolveColor(color: keyof Theme | Color | undefined, theme: Theme): Color | undefined {
  if (!color) return undefined;
  // Check if it's a raw color (starts with rgb(, #, ansi256(, or ansi:)
  if (color.startsWith('rgb(') || color.startsWith('#') || color.startsWith('ansi256(') || color.startsWith('ansi:')) {
    return color as Color;
  }
  // It's a theme key - resolve it
  return theme[color as keyof Theme] as Color;
}

/**
 * Theme-aware Text component that resolves theme color keys to raw colors.
 * This wraps the base Text component with theme resolution.
 *
 * CC 2.1.300 changelog #47 — official v300 wrapper @235309350/235309900
 * (byte-verified): the standalone caller `faintInk` prop was removed (v299
 * @234021584: `G=I&&T&&!_?j:void 0` required callers to opt in) and is now
 * computed automatically for ALL dimColor text:
 *   A=f===void 0?!1:f          (dimColor)
 *   W=Ae(Wet)                  (useContext — the sole provider `pE` @245282095
 *                               sets `hovered && !expanded`, a message-row
 *                               HOVER context, byte-identical in v299 as `$7e`)
 *   L=A&&!W?_.inactive:Y(d,_)  (resolvedColor)
 *   const G=A&&!W?D:void 0     (faintInk)
 * Under the dark ANSI theme (inactive 'ansi:white' vs text 'ansi:whiteBright')
 * dim text was indistinguishable on 16-color terminals; faintInk lets the
 * painter add SGR-2 (applyTextStyles whitish branch). OCC's hover analog is
 * TextHoverColorContext: when it recolors uncolored text the dim path is
 * inactive, so faintInk stays undefined (mirrors `!W`).
 */
export default function ThemedText(t0) {
  const $ = _c(11);
  const {
    color,
    backgroundColor,
    dimColor: t1,
    bold: t2,
    italic: t3,
    underline: t4,
    strikethrough: t5,
    inverse: t6,
    wrap: t7,
    children
  } = t0;
  const dimColor = t1 === undefined ? false : t1;
  const bold = t2 === undefined ? false : t2;
  const italic = t3 === undefined ? false : t3;
  const underline = t4 === undefined ? false : t4;
  const strikethrough = t5 === undefined ? false : t5;
  const inverse = t6 === undefined ? false : t6;
  const wrap = t7 === undefined ? "wrap" : t7;
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const hoverColor = useContext(TextHoverColorContext);
  const isHoverOverride = !color && Boolean(hoverColor);
  const resolvedColor = isHoverOverride ? resolveColor(hoverColor, theme) : dimColor ? theme.inactive as Color : resolveColor(color, theme);
  // Official v300: `const G=A&&!W?D:void 0` — dimColor && !hovered → the
  // resolved (inactive) color, else undefined. Callers never pass faintInk.
  const faintInk = dimColor && !isHoverOverride ? resolvedColor : undefined;
  const resolvedBackgroundColor = backgroundColor ? theme[backgroundColor] as Color : undefined;
  let t8;
  if ($[0] !== bold || $[1] !== children || $[2] !== inverse || $[3] !== italic || $[4] !== resolvedBackgroundColor || $[5] !== resolvedColor || $[6] !== strikethrough || $[7] !== underline || $[8] !== wrap || $[9] !== faintInk) {
    t8 = <Text color={resolvedColor} backgroundColor={resolvedBackgroundColor} faintInk={faintInk} bold={bold} italic={italic} underline={underline} strikethrough={strikethrough} inverse={inverse} wrap={wrap}>{children}</Text>;
    $[0] = bold;
    $[1] = children;
    $[2] = inverse;
    $[3] = italic;
    $[4] = resolvedBackgroundColor;
    $[5] = resolvedColor;
    $[6] = strikethrough;
    $[7] = underline;
    $[8] = wrap;
    $[9] = faintInk;
    $[10] = t8;
  } else {
    t8 = $[10];
  }
  return t8;
}
