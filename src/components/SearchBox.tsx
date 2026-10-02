import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Box, Text } from '../ink.js';
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js';
import { stringWidth } from '../ink/stringWidth.js';
import { isScreenReaderEnabled } from '../utils/screenReader.js';
type Props = {
  query: string;
  placeholder?: string;
  isFocused: boolean;
  isTerminalFocused: boolean;
  prefix?: string;
  width?: number | string;
  cursorOffset?: number;
  borderless?: boolean;
};
export function SearchBox(t0) {
  const $ = _c(18);
  const {
    query,
    placeholder: t1,
    isFocused,
    isTerminalFocused,
    prefix: t2,
    width,
    cursorOffset,
    borderless: t3
  } = t0;
  const placeholder = t1 === undefined ? "Search\u2026" : t1;
  const prefix = t2 === undefined ? "\u2315" : t2;
  const borderless = t3 === undefined ? false : t3;
  const offset = cursorOffset ?? query.length;
  // Screen-reader gating (official v287 `By` delta; Me = Ze() = isScreenReaderEnabled()).
  // Under SR the box renders borderless: official `borderStyle:ge?"round":void 0`
  // and `paddingX:ge?1:0` with ge=false under SR \u2192 borderStyle undefined, paddingX 0.
  // OCC's `borderless` prop is the equivalent of official `!ge`, so SR folds into it.
  const srEnabled = isScreenReaderEnabled();
  const effectiveBorderless = borderless || srEnabled;
  const t4 = effectiveBorderless ? undefined : "round";
  const t5 = isFocused ? "suggestion" : undefined;
  const t6 = !isFocused;
  const t7 = effectiveBorderless ? 0 : 1;
  const t8 = !isFocused;
  // Declare the native cursor at the caret so screen readers / magnifiers track
  // it (official v287 `By`: cE({line:ne+we.line, column:q+we.column, active:J&&!ue,
  // visible:je})). Under SR the box is borderless, so the border/padding offsets
  // (official q/ne) collapse to 0 and the caret column is just its position within
  // the rendered `{prefix} {query}` layout. Column is display-width (cells),
  // matching OCC's declared-cursor convention (Cursor.getPosition \u2192
  // stringIndexToDisplayWidth). `active` mirrors official `J&&!ue` (box focused),
  // gated on SR so non-SR cursor behavior is unchanged \u2014 SearchBox previously
  // declared nothing, and useDeclaredCursor's node-guarded inactive clear never
  // clobbers a sibling input's declaration.
  const cursorColumn = stringWidth(prefix) + 1 + stringWidth(query.slice(0, offset));
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: cursorColumn,
    active: srEnabled && isFocused
  });
  let t9;
  if ($[0] !== isFocused || $[1] !== isTerminalFocused || $[2] !== offset || $[3] !== placeholder || $[4] !== query) {
    t9 = isFocused ? <>{query ? isTerminalFocused ? <><Text>{query.slice(0, offset)}</Text><Text inverse={true}>{offset < query.length ? query[offset] : " "}</Text>{offset < query.length && <Text>{query.slice(offset + 1)}</Text>}</> : <Text>{query}</Text> : isTerminalFocused ? <><Text inverse={true}>{placeholder.charAt(0)}</Text><Text dimColor={true}>{placeholder.slice(1)}</Text></> : <Text dimColor={true}>{placeholder}</Text>}</> : query ? <Text>{query}</Text> : <Text>{placeholder}</Text>;
    $[0] = isFocused;
    $[1] = isTerminalFocused;
    $[2] = offset;
    $[3] = placeholder;
    $[4] = query;
    $[5] = t9;
  } else {
    t9 = $[5];
  }
  let t10;
  if ($[6] !== prefix || $[7] !== t8 || $[8] !== t9) {
    t10 = <Text dimColor={t8}>{prefix}{" "}{t9}</Text>;
    $[6] = prefix;
    $[7] = t8;
    $[8] = t9;
    $[9] = t10;
  } else {
    t10 = $[9];
  }
  let t11;
  if ($[10] !== t10 || $[11] !== t4 || $[12] !== t5 || $[13] !== t6 || $[14] !== t7 || $[15] !== width || $[16] !== cursorRef) {
    t11 = <Box ref={cursorRef} flexShrink={0} borderStyle={t4} borderColor={t5} borderDimColor={t6} paddingX={t7} width={width}>{t10}</Box>;
    $[10] = t10;
    $[11] = t4;
    $[12] = t5;
    $[13] = t6;
    $[14] = t7;
    $[15] = width;
    $[16] = cursorRef;
    $[17] = t11;
  } else {
    t11 = $[17];
  }
  return t11;
}
