import { describe, expect, it } from 'vitest';
import { captureImage, resolveImage } from '../src/core/image-anchor';
import { captureText, resolveText } from '../src/core/text-anchor';
import type { TextTarget } from '../src/core/model';

function select(doc: Document, selector: string, start: number, end: number): Range {
  const node = doc.querySelector(selector)?.firstChild;
  if (!node) throw new Error(`No text node for ${selector}`);
  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

function imageState(image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  });
}

describe('text anchors', () => {
  it('captures Chinese text with a normalized reading offset and resolves it after a distant sibling insertion', () => {
    document.body.innerHTML = '<main id="story"><p>这是足够长的前文，用来保持选中文本之前的上下文不变。这里还有更多内容。</p><p id="target">中文 <em>重点</em> 文本</p></main>';
    const range = select(document, '#target em', 0, 2);
    const target = captureText(range);
    expect(target.exact).toBe('重点');
    expect(target.rootSelector).toBe('main#story');
    document.querySelector('#target')?.insertAdjacentHTML('afterend', '<aside>新插入的同级说明文字。</aside>');
    const result = resolveText(target, document);
    expect(result.status).toBe('located');
    expect(result.range?.toString()).toBe('重点');
  });

  it('treats inline markup and br as readable whitespace', () => {
    document.body.innerHTML = '<main><p id="line">alpha <strong>beta</strong><br>gamma</p></main>';
    const text = document.querySelector('#line')?.textContent;
    expect(text).toContain('beta');
    const range = select(document, 'strong', 0, 4);
    const target = captureText(range);
    expect(target.exact).toBe('beta');
    expect(target.prefix.endsWith('alpha ')).toBe(true);
    expect(target.suffix.startsWith(' gamma')).toBe(true);
  });

  it('does not rebind an edited selection to a similar string', () => {
    document.body.innerHTML = '<main id="story"><p id="source">prefix selected suffix</p></main>';
    const target = captureText(select(document, '#source', 7, 15));
    document.querySelector('#source')!.textContent = 'prefix selection suffix';
    const result = resolveText(target, document);
    expect(result.status).toBe('unresolved');
  });

  it('fails closed when exact text and its context are ambiguous inside the stable container', () => {
    document.body.innerHTML = '<main id="story"><p id="stable">A目标B A目标B</p></main>';
    const target: TextTarget = {
      exact: '目标', prefix: 'A', suffix: 'B', start: 1, end: 3,
      rootSelector: 'main#story', containerId: 'stable',
    };
    const result = resolveText(target, document);
    expect(result.status).toBe('unresolved');
    expect(result.reason).toMatch(/ambiguous/);
  });

  it('uses the replacement root only after exact text and context still verify', () => {
    document.body.innerHTML = '<main id="story"><p id="stable">before chosen after</p></main>';
    const target = captureText(select(document, '#stable', 7, 13));
    document.querySelector('#story')!.outerHTML = '<main id="story"><p id="stable">before chosen after</p></main>';
    const result = resolveText(target, document);
    expect(result.status).toBe('located');
    expect(result.range?.toString()).toBe('chosen');
  });
});

describe('image anchors', () => {
  it('uses source plus stable selector/context to distinguish duplicate image URLs', () => {
    document.body.innerHTML = '<main><figure id="first"><img id="one" src="/same.png" alt="one"><figcaption>first caption</figcaption></figure><figure id="second"><img id="two" src="/same.png" alt="two"><figcaption>second caption</figcaption></figure></main>';
    const first = document.querySelector('#one') as HTMLImageElement;
    const second = document.querySelector('#two') as HTMLImageElement;
    imageState(first, 400, 200);
    imageState(second, 400, 200);
    const target = captureImage(second);
    const result = resolveImage(target, document);
    expect(result.status).toBe('located');
    expect(result.image).toBe(second);
  });

  it('does not accept a duplicate URL as an ordinal-only image match', () => {
    document.body.innerHTML = '<img src="/same.png"><img src="/same.png">';
    const images = Array.from(document.images);
    for (const image of images) imageState(image, 20, 20);
    const target = captureImage(images[0]!);
    target.selector = 'img[data-missing]';
    target.alt = '';
    target.context = '';
    const result = resolveImage(target, document);
    expect(result.status).toBe('unresolved');
  });
});
