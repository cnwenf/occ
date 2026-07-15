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
