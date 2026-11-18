import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import type { ParsedDocument } from '../src/index.js';

const rowStyles = [
  ['without outer pipes', '', '', '\n'],
  ['with a leading pipe only', '| ', '', '\n'],
  ['with a closing pipe only', '', ' |', '\n'],
  ['with both outer pipes', '| ', ' |', '\n'],
  ['with surrounding whitespace', '  ', '\t', '\n'],
  ['with CRLF endings', '', '', '\r\n'],
] as const;

async function parseMarkdown(content: string): Promise<ParsedDocument> {
  const form = new FormData();
  form.append('file', new File([content], 'table.md', { type: 'text/markdown' }));
  const response = await app.request('/v1/detect', { method: 'POST', body: form });
  expect(response.status).toBe(200);
  const result = await response.json() as { document: ParsedDocument };
  return result.document;
}

describe('Markdown table pipe boundaries', () => {
  it.each(rowStyles)('preserves an escaped pipe at the end of a header %s', async (_name, start, end, eol) => {
    const content = [
      `${start}Key | Symbol\\|${end}`,
      `${start}--- | ---${end}`,
      `${start}alpha | value${end}`,
    ].join(eol);

    expect((await parseMarkdown(content)).elements).toEqual([
      expect.objectContaining({
        type: 'table', headers: ['Key', 'Symbol|'], rows: [['alpha', 'value']],
        colCount: 2, rowCount: 1,
      }),
    ]);
  });

  it.each(rowStyles)('preserves an escaped pipe at the end of a data cell %s', async (_name, start, end, eol) => {
    const content = [
      `${start}Key | Symbol${end}`,
      `${start}--- | ---${end}`,
      `${start}alpha | value雪\\|${end}`,
    ].join(eol);

    expect((await parseMarkdown(content)).elements).toEqual([
      expect.objectContaining({
        type: 'table', headers: ['Key', 'Symbol'], rows: [['alpha', 'value雪|']],
        colCount: 2, rowCount: 1,
      }),
    ]);
  });

  it('retains interior escapes and empty cells when ordinary closing pipes are present', async () => {
    const content = [
      '| A | B |',
      '|---|---|',
      '|left\\|middle|right|',
      '|value||',
      '|||',
    ].join('\n');

    expect((await parseMarkdown(content)).elements).toEqual([
      expect.objectContaining({
        type: 'table', headers: ['A', 'B'],
        rows: [['left|middle', 'right'], ['value', ''], ['', '']],
        colCount: 2, rowCount: 3,
      }),
    ]);
  });
});
