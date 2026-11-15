import { describe, expect, it } from 'vitest';
import { detectFormat } from '../src/detector.js';
import { normalize } from '../src/normalizer.js';

const exampleTable = ['| Example |', '| --- |', '| literal |'];
const reportTable = ['| Result |', '| --- |', '| measured |'];

function parseMarkdown(lines: string[]) {
  const buffer = Buffer.from(lines.join('\n'));
  return normalize(buffer, detectFormat(buffer, 'report.md'));
}

describe('Markdown fenced-code boundaries (CommonMark 4.5)', () => {
  it.each([
    ['short backticks', '````markdown', '```', '````'],
    ['short tildes', '~~~~text', '~~~', '~~~~'],
    ['different marker inside backticks', '```markdown', '~~~', '```'],
    ['different marker inside tildes', '~~~text', '```', '~~~'],
    ['backticks with trailing text', '```markdown', '``` still code', '```'],
    ['tildes with trailing text', '~~~text', '~~~ still code', '~~~'],
    ['four-space indentation', '```', '    ```', '```'],
    ['tab indentation', '~~~', '\t~~~', '~~~'],
    ['non-ASCII trailing whitespace', '```', '```\u00a0', '```'],
  ])('keeps %s inside the code example', (_name, opening, invalidClosing, closing) => {
    const codeLines = [opening, invalidClosing, '# Example heading', ...exampleTable, closing];
    const doc = parseMarkdown([...codeLines, '# Report', ...reportTable]);

    expect(doc.elements.map((element) => element.type)).toEqual(['paragraph', 'heading', 'table']);
    expect(doc.elements[0]).toMatchObject({ text: codeLines.join('\n') });
    expect(doc.elements[1]).toMatchObject({ text: 'Report', level: 1 });
    expect(doc.elements[2]).toMatchObject({ headers: ['Result'], rows: [['measured']] });
  });

  it.each([
    ['```markdown', '```'],
    ['~~~text', '~~~'],
    ['```', '`````'],
    ['~~~~', '~~~~~'],
    ['   ```js', '  ``` \t'],
    [' ~~~js`', '~~~\t '],
  ])('resumes parsing after valid fences %s / %s', (opening, closing) => {
    const codeLines = [opening, ...exampleTable, closing];
    const doc = parseMarkdown([...codeLines, ...reportTable]);

    expect(doc.elements.map((element) => element.type)).toEqual(['paragraph', 'table']);
    expect(doc.elements[0]).toMatchObject({ text: codeLines.join('\n') });
    expect(doc.elements[1]).toMatchObject({ headers: ['Result'], rows: [['measured']] });
  });

  it.each(['```markdown', '~~~text'])('keeps an unclosed %s block literal until EOF', (opening) => {
    const lines = [opening, '# Example heading', ...exampleTable];
    const doc = parseMarkdown(lines);

    expect(doc.elements).toHaveLength(1);
    expect(doc.elements[0]).toMatchObject({ type: 'paragraph', text: lines.join('\n') });
  });

  it.each([
    ['backticks with line separator', '```js\u2028x', '```'],
    ['backticks with paragraph separator', '```js\u2029x', '```'],
    ['tildes with line separator', '~~~js\u2028x', '~~~'],
    ['tildes with paragraph separator', '~~~js\u2029x', '~~~'],
  ])('accepts Unicode info strings: %s', (_name, opening, closing) => {
    const codeLines = [opening, '# Example heading', ...exampleTable, closing];
    const doc = parseMarkdown([...codeLines, '# Report', ...reportTable]);

    expect(doc.elements.map((element) => element.type)).toEqual(['paragraph', 'heading', 'table']);
    expect(doc.elements[0]).toMatchObject({ text: codeLines.join('\n') });
    expect(doc.elements[1]).toMatchObject({ text: 'Report', level: 1 });
    expect(doc.elements[2]).toMatchObject({ headers: ['Result'], rows: [['measured']] });
  });

  it('does not open a backtick fence whose info string contains a backtick', () => {
    const opening = '```language`invalid';
    const doc = parseMarkdown([opening, '# Report']);

    expect(doc.elements.map((element) => element.type)).toEqual(['paragraph', 'heading']);
    expect(doc.elements[0]).toMatchObject({ text: opening });
    expect(doc.elements[1]).toMatchObject({ text: 'Report', level: 1 });
  });

  it('keeps real tables before and after an adjacent code block in document order', () => {
    const codeLines = ['```markdown', ...exampleTable, '```'];
    const doc = parseMarkdown([...reportTable, ...codeLines, '| After |', '| --- |', '| final |']);

    expect(doc.elements.map((element) => element.type)).toEqual(['table', 'paragraph', 'table']);
    expect(doc.elements[0]).toMatchObject({ headers: ['Result'], rows: [['measured']] });
    expect(doc.elements[1]).toMatchObject({ text: codeLines.join('\n') });
    expect(doc.elements[2]).toMatchObject({ headers: ['After'], rows: [['final']] });
  });

  it('preserves pipe-only paragraph text before an adjacent fence', () => {
    const lines = ['left | right', '```markdown', ...exampleTable, '```'];
    const doc = parseMarkdown(lines);

    expect(doc.elements).toHaveLength(1);
    expect(doc.elements[0]).toMatchObject({ type: 'paragraph', text: lines.join('\n') });
  });
});
