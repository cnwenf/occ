import { describe, expect, test } from 'bun:test';
import { marked, type Tokens } from 'marked';
import { configureMarked } from '../../utils/markdown.js';
import { renderToString } from '../../utils/staticRender.js';
import { MarkdownTable } from '../MarkdownTable.js';

// Behavioral e2e for 2.1.208 #12. Feeds a markdown table STRING through the
// real marked lexer (configureMarked + marked.lexer — the exact pipeline the
// assistant-message renderer uses), then renders the resulting Tokens.Table
// through the real MarkdownTable component via renderToString (the same render
// path /plan and /export use to emit Ink output). Asserts the >200-row cap +
// verbatim notice from the official binary (`DYd=200`, `CHo(s)`).

const COLUMNS = 120;

function buildTableMd(rowCount: number): string {
  const header = '| A | B |\n|---|---|\n';
  const rows = Array.from({ length: rowCount }, (_, i) => `| row-${i} | v${i} |`).join('\n');
  return header + rows + '\n';
}

function lexTable(rowCount: number): Tokens.Table {
  configureMarked();
  const tokens = marked.lexer(buildTableMd(rowCount));
  const table = tokens.find(t => t.type === 'table');
  if (!table) throw new Error('lexer produced no table token');
  return table as unknown as Tokens.Table;
}

async function render(rowCount: number): Promise<string> {
  return renderToString(
    <MarkdownTable token={lexTable(rowCount)} highlight={null} forceWidth={COLUMNS} />,
    COLUMNS,
  );
}

describe('2.1.208 #12 markdown table row cap (e2e: lexer + render)', () => {
  test('250 rows: only first 200 render, plural notice appears', async () => {
    const out = await render(250);
    expect(out).toContain('row-0');
    expect(out).toContain('row-199');
    expect(out).not.toContain('row-200');
    expect(out).not.toContain('row-249');
    expect(out).toContain('\u2026 50 more rows not shown');
  });

  test('201 rows: only first 200 render, singular notice appears', async () => {
    const out = await render(201);
    expect(out).toContain('row-199');
    expect(out).not.toContain('row-200');
    expect(out).toContain('\u2026 1 more row not shown');
  });

  test('exactly 200 rows: all render, no notice', async () => {
    const out = await render(200);
    expect(out).toContain('row-199');
    expect(out).not.toContain('not shown');
  });
});
