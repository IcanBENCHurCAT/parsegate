import { describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import type { ParsedDocument } from '../src/index.js';

const cases = [
  { name: 'comma in a quoted value', header: 'Part,Description', row: 'A,"Bracket, blue"',
    headers: ['Part', 'Description'], values: ['A', 'Bracket, blue'], delimiter: ',' },
  { name: 'comma in a quoted header', header: 'Part,"Description, notes"', row: 'A,Bracket',
    headers: ['Part', 'Description, notes'], values: ['A', 'Bracket'], delimiter: ',' },
  { name: 'escaped quotes and delimiters in a header', header: 'Part,"Description ""blue,\tgreen;"""', row: 'A,Bracket',
    headers: ['Part', 'Description "blue,\tgreen;"'], values: ['A', 'Bracket'], delimiter: ',' },
  { name: 'escaped double quotes', header: 'Part,Description', row: 'A,"6"" tube"',
    headers: ['Part', 'Description'], values: ['A', '6" tube'], delimiter: ',' },
  { name: 'quoted empty fields', header: 'Part,Description', row: '"",""',
    headers: ['Part', 'Description'], values: ['', ''], delimiter: ',' },
  { name: 'a quoted double quote', header: 'Part,Description', row: 'A,""""',
    headers: ['Part', 'Description'], values: ['A', '"'], delimiter: ',' },
  { name: 'spaces inside quotes', header: 'Part,Description', row: 'A,"  blue  "',
    headers: ['Part', 'Description'], values: ['A', '  blue  '], delimiter: ',' },
  { name: 'quoted values with surrounding whitespace', header: 'Part,Description', row: ' A , "blue, green" ',
    headers: ['Part', 'Description'], values: ['A', 'blue, green'], delimiter: ',' },
  { name: 'Unicode and backslashes', header: 'Part,Description', row: 'A,"雪, C:\\parts"',
    headers: ['Part', 'Description'], values: ['A', '雪, C:\\parts'], delimiter: ',' },
  { name: 'tab inside a comma-separated header', header: 'Part,"Description\tnotes"', row: 'A,Bracket',
    headers: ['Part', 'Description\tnotes'], values: ['A', 'Bracket'], delimiter: ',' },
  { name: 'semicolon inside a comma-separated header', header: '"Part; notes",Description', row: 'A,Bracket',
    headers: ['Part; notes', 'Description'], values: ['A', 'Bracket'], delimiter: ',' },
  { name: 'comma inside a semicolon-separated header', header: 'Part;"Description, notes"', row: 'A;"blue; green"',
    headers: ['Part', 'Description, notes'], values: ['A', 'blue; green'], delimiter: ';' },
  { name: 'tab inside a semicolon-separated header', header: 'Part;"Description\tnotes"', row: 'A;Bracket',
    headers: ['Part', 'Description\tnotes'], values: ['A', 'Bracket'], delimiter: ';' },
  { name: 'quoted tabs in TSV', header: 'Part\tDescription', row: 'A\t"blue\tgreen"',
    headers: ['Part', 'Description'], values: ['A', 'blue\tgreen'], delimiter: '\t' },
  { name: 'ordinary comma-separated data', header: 'Part,Description', row: ' A , blue ',
    headers: ['Part', 'Description'], values: ['A', 'blue'], delimiter: ',' },
  { name: 'ordinary semicolon-separated data', header: 'Part;Description', row: 'A;blue',
    headers: ['Part', 'Description'], values: ['A', 'blue'], delimiter: ';' },
  { name: 'ordinary tab-separated data', header: 'Part\tDescription', row: 'A\tblue',
    headers: ['Part', 'Description'], values: ['A', 'blue'], delimiter: '\t' },
  { name: 'a literal quote in an unquoted value', header: 'Part,Description', row: 'A,6" tube',
    headers: ['Part', 'Description'], values: ['A', '6" tube'], delimiter: ',' },
  { name: 'an empty trailing field', header: 'Part,Description', row: 'A,',
    headers: ['Part', 'Description'], values: ['A', ''], delimiter: ',' },
] as const;

describe.each(['\n', '\r\n'])('single-line quoted CSV fields with %j line endings', (eol) => {
  it.each(cases)('preserves $name', async ({ header, row, headers, values, delimiter }) => {
    const form = new FormData();
    const filename = delimiter === '\t' ? 'parts.tsv' : 'parts.csv';
    form.append('file', new File([[header, row].join(eol)], filename, { type: 'text/plain' }));
    const response = await app.request('/v1/detect', { method: 'POST', body: form });
    expect(response.status).toBe(200);
    const { document } = await response.json() as { document: ParsedDocument };
    expect(document.elements).toEqual([
      expect.objectContaining({ type: 'table', headers, rows: [values], colCount: 2, rowCount: 1 }),
    ]);
    expect(document.metadata).toMatchObject({ rowCount: 1, columnCount: 2, delimiter });
  });
});

it('parses a large quoted header below the upload limit without overflowing the stack', async () => {
  const header = 'a'.repeat(10_000_000);
  const form = new FormData();
  form.append('file', new File([`"${header}",B\nx,y`], 'large.csv', { type: 'text/csv' }));
  const response = await app.request('/v1/detect', { method: 'POST', body: form });
  expect(response.status).toBe(200);
  const { document } = await response.json() as { document: ParsedDocument };
  const table = document.elements[0];
  expect(table.type).toBe('table');
  if (table.type !== 'table') throw new Error('Expected a table');
  expect(table.headers[0].length).toBe(header.length);
  expect(table.headers[0].startsWith('a')).toBe(true);
  expect(table.headers[0].endsWith('a')).toBe(true);
  expect(table.headers[1]).toBe('B');
  expect(table.rows).toEqual([['x', 'y']]);
  expect(table.colCount).toBe(2);
});
