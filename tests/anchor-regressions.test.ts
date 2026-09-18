import { describe, it, expect } from 'vitest';
import { captureText, resolveText, createTextResolver } from '../src/core/text-anchor';

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
    document.body.innerHTML = `<article>${Array.from({ length: 200 }, (_, i) => `<p id="p${i}">Paragraph ${i}: independent annotation 测试内容.</p>`).join('')}</article>`;
    const targets = Array.from(document.querySelectorAll('p')).map(p => {
      const range = document.createRange(); range.selectNodeContents(p); return captureText(range);
    });
    const resolver = createTextResolver();
    expect(targets.filter(t => resolver(t).status === 'located')).toHaveLength(200);
  });
});
