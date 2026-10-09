import { c as _c } from "react/compiler-runtime";
import React from 'react';
import Link from './components/Link.js';
import Text from './components/Text.js';
import type { Color } from './styles.js';
import { type NamedColor, Parser, type Color as TermioColor, type TextStyle } from './termio.js';
type Props = {
  children: string;
  /** When true, force all text to be rendered with dim styling */
  dimColor?: boolean;
};
type SpanProps = {
  color?: Color;
  backgroundColor?: Color;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  hyperlink?: string;
};

/**
 * Component that parses ANSI escape codes and renders them using Text components.
 *
 * Use this as an escape hatch when you have pre-formatted ANSI strings from
 * external tools (like cli-highlight) that need to be rendered in Ink.
 *
 * Memoized to prevent re-renders when parent changes but children string is the same.
 */
export const Ansi = React.memo(function Ansi(t0: { children: React.ReactNode; dimColor?: boolean }) {
  const $ = _c(12);
  const {
    children,
    dimColor
  } = t0;
  if (typeof children !== "string") {
    let t1;
    if ($[0] !== children || $[1] !== dimColor) {
      t1 = dimColor ? <Text dim={true}>{String(children)}</Text> : <Text>{String(children)}</Text>;
      $[0] = children;
      $[1] = dimColor;
      $[2] = t1;
    } else {
      t1 = $[2];
    }
    return t1;
  }
  if (children === "") {
    return null;
  }
  let t1;
  let t2;
  if ($[3] !== children || $[4] !== dimColor) {
    t2 = Symbol.for("react.early_return_sentinel");
    bb0: {
      const spans = parseToSpans(children);
      if (spans.length === 0) {
        t2 = null;
        break bb0;
      }
      if (spans.length === 1 && !hasAnyProps(spans[0].props)) {
        t2 = dimColor ? <Text dim={true}>{spans[0].text}</Text> : <Text>{spans[0].text}</Text>;
        break bb0;
      }
      let t3;
      if ($[7] !== dimColor) {
        t3 = (span, i) => {
          const hyperlink = span.props.hyperlink;
          if (dimColor) {
            span.props.dim = true;
          }
          const hasTextProps = hasAnyTextProps(span.props);
          if (hyperlink) {
            return hasTextProps ? <Link key={i} url={hyperlink}><StyledText color={span.props.color} backgroundColor={span.props.backgroundColor} dim={span.props.dim} bold={span.props.bold} italic={span.props.italic} underline={span.props.underline} strikethrough={span.props.strikethrough} inverse={span.props.inverse}>{span.text}</StyledText></Link> : <Link key={i} url={hyperlink}>{span.text}</Link>;
          }
          return hasTextProps ? <StyledText key={i} color={span.props.color} backgroundColor={span.props.backgroundColor} dim={span.props.dim} bold={span.props.bold} italic={span.props.italic} underline={span.props.underline} strikethrough={span.props.strikethrough} inverse={span.props.inverse}>{span.text}</StyledText> : span.text;
        };
        $[7] = dimColor;
        $[8] = t3;
      } else {
        t3 = $[8];
      }
      t1 = spans.map(t3);
    }
    $[3] = children;
    $[4] = dimColor;
    $[5] = t1;
    $[6] = t2;
  } else {
    t1 = $[5];
    t2 = $[6];
  }
  if (t2 !== Symbol.for("react.early_return_sentinel")) {
    return t2;
  }
  const content = t1;
  let t3;
  if ($[9] !== content || $[10] !== dimColor) {
    t3 = dimColor ? <Text dim={true}>{content}</Text> : <Text>{content}</Text>;
    $[9] = content;
    $[10] = dimColor;
    $[11] = t3;
  } else {
    t3 = $[11];
  }
  return t3;
});
type Span = {
  text: string;
  props: SpanProps;
};

/**
 * Parse an ANSI string into spans using the termio parser.
 */
function parseToSpans(input: string): Span[] {
  const parser = new Parser();
  const actions = parser.feed(input);
  const spans: Span[] = [];
  let currentHyperlink: string | undefined;
  for (const action of actions) {
    if (action.type === 'link') {
      if (action.action.type === 'start') {
        currentHyperlink = action.action.url;
      } else {
        currentHyperlink = undefined;
      }
      continue;
    }
    if (action.type === 'text') {
      const text = action.graphemes.map(g => g.value).join('');
      if (!text) continue;
      const props = textStyleToSpanProps(action.style);
      if (currentHyperlink) {
        props.hyperlink = currentHyperlink;
      }

      // Try to merge with previous span if props match
      const lastSpan = spans[spans.length - 1];
      if (lastSpan && propsEqual(lastSpan.props, props)) {
        lastSpan.text += text;
      } else {
        spans.push({
          text,
          props
        });
      }
    }
  }
  return spans;
}

/**
 * Convert termio's TextStyle to SpanProps.
 */
function textStyleToSpanProps(style: TextStyle): SpanProps {
  const props: SpanProps = {};
  if (style.bold) props.bold = true;
  if (style.dim) props.dim = true;
  if (style.italic) props.italic = true;
  if (style.underline !== 'none') props.underline = true;
  if (style.strikethrough) props.strikethrough = true;
  if (style.inverse) props.inverse = true;
  const fgColor = colorToString(style.fg);
  if (fgColor) props.color = fgColor;
  const bgColor = colorToString(style.bg);
  if (bgColor) props.backgroundColor = bgColor;
  return props;
}

// Map termio named colors to the ansi: format
const NAMED_COLOR_MAP: Record<NamedColor, string> = {
  black: 'ansi:black',
  red: 'ansi:red',
  green: 'ansi:green',
  yellow: 'ansi:yellow',
  blue: 'ansi:blue',
  magenta: 'ansi:magenta',
  cyan: 'ansi:cyan',
  white: 'ansi:white',
  brightBlack: 'ansi:blackBright',
  brightRed: 'ansi:redBright',
  brightGreen: 'ansi:greenBright',
  brightYellow: 'ansi:yellowBright',
  brightBlue: 'ansi:blueBright',
  brightMagenta: 'ansi:magentaBright',
  brightCyan: 'ansi:cyanBright',
  brightWhite: 'ansi:whiteBright'
};

/**
 * Convert termio's Color to the string format used by Ink.
 */
function colorToString(color: TermioColor): Color | undefined {
  switch (color.type) {
    case 'named':
      return NAMED_COLOR_MAP[color.name] as Color;
    case 'indexed':
      return `ansi256(${color.index})` as Color;
    case 'rgb':
      return `rgb(${color.r},${color.g},${color.b})` as Color;
    case 'default':
      return undefined;
  }
}

/**
 * Check if two SpanProps are equal for merging.
 */
function propsEqual(a: SpanProps, b: SpanProps): boolean {
  return a.color === b.color && a.backgroundColor === b.backgroundColor && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.strikethrough === b.strikethrough && a.inverse === b.inverse && a.hyperlink === b.hyperlink;
}
function hasAnyProps(props: SpanProps): boolean {
  return props.color !== undefined || props.backgroundColor !== undefined || props.dim === true || props.bold === true || props.italic === true || props.underline === true || props.strikethrough === true || props.inverse === true || props.hyperlink !== undefined;
}
function hasAnyTextProps(props: SpanProps): boolean {
  return props.color !== undefined || props.backgroundColor !== undefined || props.dim === true || props.bold === true || props.italic === true || props.underline === true || props.strikethrough === true || props.inverse === true;
}

// Text style props without weight (bold/dim) - these are handled separately
type BaseTextStyleProps = {
  color?: Color;
  backgroundColor?: Color;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
};

// Wrapper component that forwards bold/dim to Text.
//
// CC 2.1.295: bold and dim COEXIST — the official styled-text emitter `wqe`
// (v294 `XGe` identical) applies both when both are set:
//   if(i.bold)e=ge.bold(e); if(i.dim)e=ge.dim(e)
// and the official SGR parser maps 1→bold, 2→dim independently (22 clears
// both). The previous OCC version treated them as mutually exclusive and
// dropped `bold` whenever `dim` was set, so bold drawn directly after dim
// (e.g. in piped output) rendered faint. Text's runtime already spreads both
// flags; only the WeightProps type union needed widening.
function StyledText(t0) {
  const $ = _c(10);
  let bold;
  let children;
  let dim;
  let rest;
  if ($[0] !== t0) {
    ({
      bold,
      dim,
      children,
      ...rest
    } = t0);
    $[0] = t0;
    $[1] = bold;
    $[2] = children;
    $[3] = dim;
    $[4] = rest;
  } else {
    bold = $[1];
    children = $[2];
    dim = $[3];
    rest = $[4];
  }
  let t1;
  if ($[5] !== bold || $[6] !== children || $[7] !== dim || $[8] !== rest) {
    t1 = <Text {...rest} bold={bold === true} dim={dim === true}>{children}</Text>;
    $[5] = bold;
    $[6] = children;
    $[7] = dim;
    $[8] = rest;
    $[9] = t1;
  } else {
    t1 = $[9];
  }
  return t1;
}
