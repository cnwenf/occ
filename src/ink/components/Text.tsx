import { c as _c } from "react/compiler-runtime";
import type { ReactNode } from 'react';
import React from 'react';
import type { Color, Styles, TextStyles } from '../styles.js';
type BaseProps = {
  /**
   * Change text color. Accepts a raw color value (rgb, hex, ansi).
   */
  readonly color?: Color;

  /**
   * Same as `color`, but for background.
   */
  readonly backgroundColor?: Color;

  /**
   * CC 2.1.300 changelog #47 (official `Dc` @231403881): themed-dim escape
   * hatch. When equal to `color` and the color is "whitish" (renders
   * indistinguishable from white/black at the current chalk level), the
   * painter adds SGR-2 dim so secondary text stays distinguishable under the
   * dark ANSI theme and on 16-color terminals. Set automatically by
   * ThemedText — callers do not pass it manually (the official v300 wrapper
   * removed the standalone caller prop @235309350).
   */
  readonly faintInk?: Color;

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
   * If `truncate-*` is passed, Ink will truncate text instead, what will result in one line of text with the rest cut off.
   */
  readonly wrap?: Styles['textWrap'];
  readonly children?: ReactNode;
};

/**
 * Weight styling. CC 2.1.295: bold and dim COEXIST — the official emitter
 * `wqe` applies both when both are set (`if(i.bold)e=ge.bold(e);
 * if(i.dim)e=ge.dim(e)`), SGR 1/2 set them independently, and SGR 22 clears
 * both. The runtime below already spreads both flags into the text styles;
 * the union keeps the pre-existing single-flag shapes and adds the combined
 * one. (The old "mutually exclusive" union was an OCC invention contradicted
 * by the official binary.)
 */
type WeightProps = {
  bold?: never;
  dim?: never;
} | {
  bold: boolean;
  dim?: never;
} | {
  dim: boolean;
  bold?: never;
} | {
  bold: boolean;
  dim: boolean;
};
export type Props = BaseProps & WeightProps;
const memoizedStylesForWrap: Record<NonNullable<Styles['textWrap']>, Styles> = {
  wrap: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'wrap'
  },
  'wrap-trim': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'wrap-trim'
  },
  end: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'end'
  },
  middle: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'middle'
  },
  'truncate-end': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate-end'
  },
  truncate: {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate'
  },
  'truncate-middle': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate-middle'
  },
  'truncate-start': {
    flexGrow: 0,
    flexShrink: 1,
    flexDirection: 'row',
    textWrap: 'truncate-start'
  }
} as const;

/**
 * This component can display text, and change its style to make it colorful, bold, underline, italic or strikethrough.
 */
export default function Text(t0) {
  const $ = _c(32);
  const {
    color,
    backgroundColor,
    faintInk,
    bold,
    dim,
    italic: t1,
    underline: t2,
    strikethrough: t3,
    inverse: t4,
    wrap: t5,
    children
  } = t0;
  const italic = t1 === undefined ? false : t1;
  const underline = t2 === undefined ? false : t2;
  const strikethrough = t3 === undefined ? false : t3;
  const inverse = t4 === undefined ? false : t4;
  const wrap = t5 === undefined ? "wrap" : t5;
  if (children === undefined || children === null) {
    return null;
  }
  let t6;
  if ($[0] !== color) {
    t6 = color && {
      color
    };
    $[0] = color;
    $[1] = t6;
  } else {
    t6 = $[1];
  }
  let t7;
  if ($[2] !== backgroundColor) {
    t7 = backgroundColor && {
      backgroundColor
    };
    $[2] = backgroundColor;
    $[3] = t7;
  } else {
    t7 = $[3];
  }
  let t8;
  if ($[4] !== faintInk) {
    t8 = faintInk && {
      faintInk
    };
    $[4] = faintInk;
    $[5] = t8;
  } else {
    t8 = $[5];
  }
  let t9;
  if ($[6] !== dim) {
    t9 = dim && {
      dim
    };
    $[6] = dim;
    $[7] = t9;
  } else {
    t9 = $[7];
  }
  let t10;
  if ($[8] !== bold) {
    t10 = bold && {
      bold
    };
    $[8] = bold;
    $[9] = t10;
  } else {
    t10 = $[9];
  }
  let t11;
  if ($[10] !== italic) {
    t11 = italic && {
      italic
    };
    $[10] = italic;
    $[11] = t11;
  } else {
    t11 = $[11];
  }
  let t12;
  if ($[12] !== underline) {
    t12 = underline && {
      underline
    };
    $[12] = underline;
    $[13] = t12;
  } else {
    t12 = $[13];
  }
  let t13;
  if ($[14] !== strikethrough) {
    t13 = strikethrough && {
      strikethrough
    };
    $[14] = strikethrough;
    $[15] = t13;
  } else {
    t13 = $[15];
  }
  let t14;
  if ($[16] !== inverse) {
    t14 = inverse && {
      inverse
    };
    $[16] = inverse;
    $[17] = t14;
  } else {
    t14 = $[17];
  }
  let t15;
  if ($[18] !== t11 || $[19] !== t12 || $[20] !== t13 || $[21] !== t14 || $[22] !== t6 || $[23] !== t7 || $[24] !== t8 || $[25] !== t9 || $[26] !== t10) {
    t15 = {
      ...t6,
      ...t7,
      ...t8,
      ...t9,
      ...t10,
      ...t11,
      ...t12,
      ...t13,
      ...t14
    };
    $[18] = t11;
    $[19] = t12;
    $[20] = t13;
    $[21] = t14;
    $[22] = t6;
    $[23] = t7;
    $[24] = t8;
    $[25] = t9;
    $[26] = t10;
    $[27] = t15;
  } else {
    t15 = $[27];
  }
  const textStyles = t15;
  const t16 = memoizedStylesForWrap[wrap];
  let t17;
  if ($[28] !== children || $[29] !== t16 || $[30] !== textStyles) {
    t17 = <ink-text style={t16} textStyles={textStyles}>{children}</ink-text>;
    $[28] = children;
    $[29] = t16;
    $[30] = textStyles;
    $[31] = t17;
  } else {
    t17 = $[31];
  }
  return t17;
}
