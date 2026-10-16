import { describe, expect, test } from 'bun:test';
import type { Tokens } from 'marked';
import { renderToString } from '../../utils/staticRender.js';
import { MarkdownTable, MAX_TABLE_ROWS, formatTruncationNotice } from '../MarkdownTable.js';

// 2.1.208 #12: very large markdown tables (>200 rows) render only the first
// 200 data rows and append a notice, to avoid stalling the terminal. Matches
// the official binary: threshold `DYd = 200`, notice `CHo(s)` =
// `… N more row(s) not shown` (… = U+2026, singular "row" for 1, plural
// "rows" otherwise). The notice sits on its own line below the bottom border
// (horizontal) or below a `─` separator (vertical).

const COLUMNS = 120;

/** Build a `Tokens.Table` with `rowCount` data rows and 2 columns. Row N's
 *  first cell is `row-N` so individual rows are identifiable in the output. */
function makeTable(rowCount: number): Tokens.Table {
  const cell = (text: string) => ({
    type: 'text' as const,
    raw: text,
    text,
    tokens: [{ type: 'text' as const, raw: text, text }],
  });
  const header = [{ type: 'text', text: 'A', tokens: [{ type: 'text', raw: 'A', text: 'A' }] }];
  const rows = Array.from({ length: rowCount }, (_, i) => {
    const v = `row-${i}`;
    return [cell(v), cell(`v${i}`)];
  });
  return {
    type: 'table',
    raw: '',
    header,
    rows,
    align: ['left', 'left'],
  } as unknown as Tokens.Table;
}

async function renderTable(rowCount: number): Promise<string> {
  return renderToString(
    <MarkdownTable token={makeTable(rowCount)} highlight={null} forceWidth={COLUMNS} />,
    COLUMNS,
  );
}

describe('2.1.208 #12 markdown table row cap', () => {
  test('MAX_TABLE_ROWS is 200 (matches binary DYd=200)', () => {
    expect(MAX_TABLE_ROWS).toBe(200);
  });

  test('formatTruncationNotice: singular for 1 omitted', () => {
    expect(formatTruncationNotice(1)).toBe('\u2026 1 more row not shown');
  });

  test('formatTruncationNotice: plural for 2+ omitted', () => {
    expect(formatTruncationNotice(50)).toBe('\u2026 50 more rows not shown');
    expect(formatTruncationNotice(2)).toBe('\u2026 2 more rows not shown');
  });

  test('formatTruncationNotice: count is locale-formatted', () => {
    // 1050 -> "1,050" under en-US locale formatting (toLocaleString)
    expect(formatTruncationNotice(1050)).toBe('\u2026 1,050 more rows not shown');
  });

  test('exactly 200 rows renders all rows and no notice', async () => {
    const out = await renderTable(200);
    expect(out).toContain('row-0');
    expect(out).toContain('row-199');
    expect(out).not.toContain('not shown');
  });

  test('201 rows renders only first 200 + notice (singular "row")', async () => {
    const out = await renderTable(201);
    // first 200 rows present
    expect(out).toContain('row-0');
    expect(out).toContain('row-199');
    // 201st row (index 200) is omitted
    expect(out).not.toContain('row-200');
    // verbatim notice, singular
    expect(out).toContain('\u2026 1 more row not shown');
  });

  test('250 rows renders only first 200 + notice (plural "rows")', async () => {
    const out = await renderTable(250);
    expect(out).toContain('row-0');
    expect(out).toContain('row-199');
    expect(out).not.toContain('row-200');
    expect(out).not.toContain('row-249');
    // verbatim notice, plural: 250-200 = 50 omitted
    expect(out).toContain('\u2026 50 more rows not shown');
  });
});

// CC 2.1.301 changelog #25 \u2014 header-only markdown tables (zero body rows)
// rendered NOTHING when the vertical (key-value) fallback kicked in: the
// vertical renderer iterated body rows only. Official v301 `z()` @244452938
// adds a zero-body-row branch (byte-verified):
//   if(x.length===0)return{kind:"vertical",headers:[],
//     rows:[o.header.map((M)=>k(M.tokens))],truncatedCount:c};
// i.e. ONE keyless row whose cells are the header texts, rendered per the
// official keyless path (@244454200): bare values (no bold `label:`), empty
// cells skipped, no separators for a single row.

/** Build a `Tokens.Table` with the given headers and body rows. */
function makeTableWith(headers: string[], rows: string[][]): Tokens.Table {
  const cell = (text: string) => ({
    type: 'text' as const,
    raw: text,
    text,
    tokens: [{ type: 'text' as const, raw: text, text }],
  });
  return {
    type: 'table',
    raw: '',
    header: headers.map(cell),
    rows: rows.map(r => r.map(cell)),
    align: headers.map(() => 'left'),
  } as unknown as Tokens.Table;
}

async function render(token: Tokens.Table, width: number): Promise<string> {
  return renderToString(
    <MarkdownTable token={token} highlight={null} forceWidth={width} />,
    width,
  );
}

describe('CC 2.1.301 #25: header-only table in vertical fallback', () => {
  test('too-wide header-only table renders one keyless line per header', async () => {
    // Arrange \u2014 8 columns at width 20: horizontal frame exceeds the
    // SAFETY_MARGIN check \u2192 vertical fallback.
    const headers = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8'];

    // Act
    const out = await render(makeTableWith(headers, []), 20);

    // Assert \u2014 non-empty (v300 rendered ''), every header present, keyless
    // (no `H1:` label form), no row separators or truncation notice.
    expect(out.trim().length).toBeGreaterThan(0);
    for (const h of headers) {
      expect(out).toContain(h);
      expect(out).not.toContain(`${h}:`);
    }
    expect(out).not.toContain('\u2500'); // no \u2500 separator (single row)
    expect(out).not.toContain('not shown');
  });

  test('header-only table forced vertical by MAX_ROW_LINES renders the header', async () => {
    // Arrange \u2014 single 59-char word at width 20: hard-wrapped header needs
    // >4 lines \u2192 useVerticalFormat.
    const longWord = 'Supercalifragilisticexpialidociousantidisestablishmentarian';

    // Act
    const out = await render(makeTableWith([longWord], []), 20);

    // Assert \u2014 non-empty; the word's characters survive (wrapped across
    // lines), no keyless-label artifacts.
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out.replace(/\s+/g, '')).toContain(longWord);
    expect(out).not.toContain(':');
  });

  test('empty header cells are skipped in the keyless row (official !g&&!C)', async () => {
    // Arrange \u2014 ['', 'Value'] at width 16 triggers the vertical fallback.
    // Act
    const out = await render(makeTableWith(['', 'Value'], []), 16);

    // Assert
    expect(out.trim()).toBe('Value');
  });

  test('header-only table at wide terminal still renders the horizontal box', async () => {
    // Regression guard: the zero-body-row branch must not affect horizontal.
    const out = await render(makeTableWith(['Name', 'Value'], []), 120);
    expect(out).toContain('\u250c'); // \u250c top border
    expect(out).toContain('Name');
    expect(out).toContain('Value');
  });

  test('body-row table in vertical fallback keeps bold `label:` lines', async () => {
    // Regression guard: existing labeled vertical path unchanged.
    // 'Name'/'Value' + one row at width 16 \u2192 vertical fallback.
    const out = await render(
      makeTableWith(['Name', 'Value'], [['alpha', 'beta']]),
      16,
    );
    expect(out).toContain('Name:');
    expect(out).toContain('alpha');
    expect(out).toContain('Value:');
    expect(out).toContain('beta');
  });
});
