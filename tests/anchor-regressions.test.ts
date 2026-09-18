import { describe, it, expect } from 'vitest';
import { captureText, resolveText, createTextResolver } from '../src/core/text-anchor';
import type { TextTarget } from '../src/core/model';

describe('real selection boundaries and large restore batches', () => {
  it('selectNodeContents after earlier siblings uses offsets in the reading root', () => {
    document.body.innerHTML = '<article><p>Earlier paragraph must not be selected.</p><p id="target">正确的目标 <b>bold text</b> 尾部</p></article>';
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#target')!);
    const target = captureText(range);
    expect(target.exact).toBe('正确的目标 bold text 尾部');
    expect(resolveText(target).range?.toString()).toBe(range.toString());
  });
  it('anchors inside the second article instead of querying the first one', () => {
    document.body.innerHTML = '<article><p>First article</p></article><article><p>The second article</p></article>';
    const range = document.createRange(); range.selectNodeContents(document.querySelectorAll('article p')[1]!);
    const target = captureText(range);
    expect(resolveText(target).range?.toString()).toBe('The second article');
  });
  it('restores 200 records using one disposable reading index', () => {
    const paragraphs = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}: independent annotation 测试内容.`);
    document.body.innerHTML = `<article>${paragraphs.map((text, i) => `<p id="p${i}">${text}</p>`).join('')}</article>`;
    // Model records already saved by previous visits. Capture is covered above;
    // doing 200 full DOM captures here measures fixture setup instead of restore.
    const normalized = paragraphs.join(' ');
    let offset = 0;
    const targets: TextTarget[] = paragraphs.map((exact, i) => {
      const start = offset, end = start + exact.length;
      offset = end + 1;
      return { exact, start, end, prefix: normalized.slice(Math.max(0, start - 64), start),
        suffix: normalized.slice(end, end + 64), rootSelector: 'article', containerId: `p${i}` };
    });
    const resolver = createTextResolver();
    const results = targets.map(t => resolver(t));
    expect(results.filter(result => result.status === 'located')).toHaveLength(200);
    expect(results.map(result => result.range?.toString())).toEqual(paragraphs);
  });
});
