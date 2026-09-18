import { request, RequestError } from '../core/client';
import { COLORS, DEFAULT_SETTINGS, type Annotation, type AnchorState, type ImageAnnotation, type ImageShape, type PageMode, type Point, type Settings, type ShapeKind, type TextAnnotation } from '../core/model';
import { captureText, createTextResolver } from '../core/text-anchor';
import { captureImage, resolveImage } from '../core/image-anchor';
import { clientToImage, getImageGeometry, type ImageGeometry } from '../core/geometry';
import { pageKey } from '../core/url';
import { button, createView, renderShape, svgElement } from './view';
import { createNotifications } from './notifications';
import { createPaletteToggle } from './palette-toggle';

type InkWindow = Window & { __webInkActive?: boolean };
export function startContent(): () => void {
  if (window.top !== window || (window as InkWindow).__webInkActive) return () => undefined;
  (window as InkWindow).__webInkActive = true;
  const view = createView();
  const notifications = createNotifications(view.toast);
  const highlightStyle = document.createElement('style'); highlightStyle.dataset.webInk = 'true';
  document.documentElement.append(highlightStyle);
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  let annotations: Annotation[] = [];
  let states: AnchorState[] = [];
  let currentUrl = pageKey(location.href);
  let pageEnabled = false;
  let modeReady = false;
  let toggleBusy = false;
  let stopped = false;
  let disabled = false;
  let disposed = false;
  let generation = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let renderFrame = 0;
  let selectedRange: Range | undefined;
  let rebinding: Annotation | undefined;
  let mode: 'idle' | 'choose-image' | 'drawing' = 'idle';
  let selectedImage: HTMLImageElement | undefined;
  let shapeKind: ShapeKind = 'rectangle';
  let currentColor: string = settings.defaultColor;
  let drawingPoints: Point[] = [];
  let drawingPointer: number | undefined;
  let previewShape: ImageShape | undefined;
  let unsaved: Annotation | undefined;
  let pendingSave = false;
  let focusId: string | undefined;
  let passiveRetryCount = 0;
  let passiveRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const images = new Map<string, HTMLImageElement>();
  const textRanges = new Map<string, Range>();
  const highlightNames = new Set<string>();
  const undo: ImageAnnotation[] = [];
  const redo: ImageAnnotation[] = [];
  const observers = new AbortController();
  const signal = observers.signal;
  const zh = () => settings.language === 'zh-CN';
  const label = (cn: string, en: string) => zh() ? cn : en;
  const palette = createPaletteToggle(view.root, () => { void changePageMode(!pageEnabled); });
  const updatePalette = () => palette.update({
    enabled: pageEnabled && !disabled && !stopped, busy: toggleBusy || pendingSave || !modeReady,
    blocked: disabled || stopped, language: settings.language,
  });
  updatePalette();
  const toast = (message: string, error = false, retry?: () => void) => {
    notifications.show(message, { kind: error ? 'error' : 'info', sticky: !!retry,
      dismissLabel: label('关闭提示', 'Dismiss'),
      actions: retry ? [
        { label: label('重试保存', 'Retry save'), run: retry },
        { label: label('放弃本次修改', 'Discard this change'), run: () => {
          unsaved = undefined; rebinding = undefined; notifications.hide(); schedulePaint();
        } },
      ] : [],
    });
  };
  const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), true);
  const enabled = () => pageEnabled && !disabled && !stopped && !disposed;
  const clearText = () => {
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) for (const name of highlightNames) CSS.highlights.delete(name);
    highlightNames.clear(); textRanges.clear(); highlightStyle.textContent = '';
  };
  const hideSelection = () => { selectedRange = undefined; view.selection.style.display = 'none'; };
  const exitDrawing = () => {
    mode = 'idle'; selectedImage = undefined; drawingPointer = undefined; drawingPoints = []; previewShape = undefined;
    view.svg.style.pointerEvents = 'none'; view.svg.style.cursor = ''; view.drawing.style.display = 'none'; schedulePaint();
  };

  async function changePageMode(next: boolean): Promise<boolean> {
    if (toggleBusy || pendingSave || disabled || stopped || disposed) return false;
    if (unsaved) {
      const record = unsaved;
      toast(label('请先处理尚未保存的修改。', 'Resolve the unsaved change before switching modes.'), true, () => { void commit(record); });
      return false;
    }
    toggleBusy = true; updatePalette();
    const url = pageKey(location.href);
    try {
      const result = await request<PageMode>({ type: 'page.mode.put', pageUrl: url, enabled: next });
      if (disposed) return false;
      if (pageKey(location.href) !== url) { queueRefresh(); return false; }
      pageEnabled = result.enabled; notifications.hide();
      await refresh();
      return enabled();
    } catch (error) { fail(error); return false; }
    finally { toggleBusy = false; updatePalette(); }
  }

  async function withPageEnabled(action: () => void) {
    if (!modeReady) await refresh();
    if (!enabled() && !await changePageMode(true)) return;
    action();
  }

  function showPalette(range: Range) {
    selectedRange = range.cloneRange();
    const rect = range.getBoundingClientRect();
    view.selection.replaceChildren();
    for (const color of COLORS) {
      const b = button('', () => { void saveSelection(color); }, `${label('高亮', 'Highlight')} ${color}`);
      b.className = 'swatch'; b.style.backgroundColor = color;
      b.addEventListener('pointerdown', e => e.preventDefault());
      view.selection.append(b);
    }
    const custom = document.createElement('input'); custom.type = 'color'; custom.value = currentColor;
    custom.title = label('自定义颜色', 'Custom color'); custom.setAttribute('aria-label', custom.title);
    custom.addEventListener('input', () => { currentColor = custom.value; });
    const apply = button(label('应用', 'Apply'), () => { void saveSelection(custom.value); });
    apply.addEventListener('pointerdown', e => e.preventDefault());
    view.selection.append(custom, apply);
    view.selection.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 320))}px`;
    view.selection.style.top = `${Math.min(window.innerHeight - 60, Math.max(8, rect.bottom + 8))}px`;
    view.selection.style.display = 'flex';
  }

  function baseRecord(color: string) {
    const now = new Date().toISOString();
    return { id: crypto.randomUUID(), pageUrl: pageKey(location.href), pageTitle: document.title,
      color, note: '', tags: [], createdAt: now, updatedAt: now, revision: 0 };
  }
  async function commit(record: Annotation, track = false) {
    if (pendingSave) return;
    pendingSave = true; unsaved = record;
    updatePalette();
    toast(label('正在保存…', 'Saving…'));
    try {
      const stored = await request<Annotation>({ type: 'annotations.put', annotation: record, expectedRevision: record.revision });
      unsaved = undefined;
      if (track && stored.kind === 'image' && stored.pageUrl === pageKey(location.href)) { undo.push(stored); redo.length = 0; }
      rebinding = undefined;
      notifications.show(label('已保存到本机', 'Saved on this device'), { kind: 'success', dismissLabel: label('关闭提示', 'Dismiss') });
      await refresh();
    } catch (error) {
      const reason = error instanceof RequestError && error.code === 'PAGE_CHANGED'
        ? label('网页已切换，请回到原页面重试。', 'The page changed. Return to the original page to retry.')
        : error instanceof Error ? error.message : String(error);
      toast(`${label('保存失败，记录尚未落盘：', 'Not saved: ')}${reason}`, true,
        () => { void commit(record, track); });
    } finally { pendingSave = false; updatePalette(); schedulePaint(); }
  }
  async function saveSelection(color: string) {
    if (!selectedRange || !enabled() || pendingSave || unsaved) return;
    try {
      const target = captureText(selectedRange);
      const record: TextAnnotation = rebinding?.kind === 'text'
        ? { ...rebinding, target, updatedAt: new Date().toISOString() }
        : { ...baseRecord(color), kind: 'text', target };
      hideSelection(); window.getSelection()?.removeAllRanges();
      await commit(record);
    } catch (error) { fail(error); }
  }

  function drawingToolbar() {
    view.drawing.replaceChildren();
    const title = document.createElement('strong'); title.textContent = 'Web Ink'; view.drawing.append(title);
    const kinds: Array<[ShapeKind, string, string]> = [
      ['rectangle', '方框', 'Rectangle'], ['ellipse', '椭圆', 'Ellipse'], ['arrow', '箭头', 'Arrow'], ['pen', '画笔', 'Pen'],
    ];
    for (const [kind, cn, en] of kinds) {
      const b = button(label(cn, en), () => { shapeKind = kind; drawingToolbar(); });
      b.setAttribute('aria-pressed', String(shapeKind === kind)); view.drawing.append(b);
    }
    const color = document.createElement('input'); color.type = 'color'; color.value = currentColor;
    color.setAttribute('aria-label', label('画笔颜色', 'Drawing color'));
    color.addEventListener('input', () => { currentColor = color.value; });
    view.drawing.append(color,
      button(label('撤销', 'Undo'), () => { void undoDrawing(); }),
      button(label('重做', 'Redo'), () => { void redoDrawing(); }),
      button(label('换图片', 'Pick image'), () => { selectedImage = undefined; mode = 'choose-image'; view.svg.style.pointerEvents = 'none'; }),
      button(label('完成', 'Done'), exitDrawing));
    view.drawing.style.display = 'flex';
  }
  function chooseImage(image: HTMLImageElement) {
    const geometry = getImageGeometry(image);
    if (!geometry) { toast(label('此图片尚未加载，或使用了暂不支持的变换。', 'Image is not loaded or has an unsupported transform.'), true); return; }
    if (rebinding?.kind === 'image') {
      try { void commit({ ...rebinding, target: captureImage(image), updatedAt: new Date().toISOString() }); exitDrawing(); }
      catch (error) { fail(error); }
      return;
    }
    selectedImage = image; mode = 'drawing';
    view.svg.style.pointerEvents = 'auto'; view.svg.style.cursor = 'crosshair';
    drawingToolbar(); schedulePaint();
  }
  function startDrawing() {
    if (!enabled()) { toast(label('请先启用此网站。', 'Enable this site first.'), true); return; }
    hideSelection(); mode = 'choose-image'; selectedImage = undefined;
    view.svg.style.pointerEvents = 'none'; drawingToolbar();
    toast(label('点击网页中的图片，然后圈画。Esc 退出。', 'Click an image, then draw. Esc to exit.'));
  }
  async function undoDrawing() {
    if (pendingSave || unsaved) return;
    const old = undo.at(-1); if (!old) return;
    try {
      await request({ type: 'annotations.delete', id: old.id, expectedRevision: old.revision });
      undo.pop(); redo.push(old); await refresh();
    } catch (error) { fail(error); }
  }
  async function redoDrawing() {
    if (pendingSave || unsaved) return;
    const old = redo.at(-1); if (!old) return;
    try {
      const record = { ...old, revision: 0, updatedAt: new Date().toISOString() };
      const saved = await request<ImageAnnotation>({ type: 'annotations.put', annotation: record, expectedRevision: 0 });
      redo.pop(); undo.push(saved); await refresh();
    } catch (error) { fail(error); }
  }

  function clippedGeometry(image: HTMLImageElement): ImageGeometry | null {
    const geometry = getImageGeometry(image); if (!geometry) return null;
    let left = Math.max(0, geometry.clipRect.x), top = Math.max(0, geometry.clipRect.y);
    let right = Math.min(innerWidth, geometry.clipRect.x + geometry.clipRect.width);
    let bottom = Math.min(innerHeight, geometry.clipRect.y + geometry.clipRect.height);
    for (let p = image.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p), r = p.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, r.left); right = Math.min(right, r.right); }
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
    }
    if (right <= left || bottom <= top) return null;
    return { imageRect: geometry.imageRect, clipRect: { x: left, y: top, width: right - left, height: bottom - top } };
  }
  function drawOne(record: ImageAnnotation, image: HTMLImageElement, suffix = '') {
    const geometry = clippedGeometry(image); if (!geometry) return;
    const clipId = `clip-${record.id}${suffix}`;
    const defs = svgElement('defs'), clip = svgElement('clipPath', { id: clipId });
    clip.append(svgElement('rect', geometry.clipRect)); defs.append(clip);
    const group = svgElement('g', { 'clip-path': `url(#${clipId})`, 'data-annotation-id': record.id });
    const shape = renderShape(record.shape, geometry, record.color);
    if (record.id === focusId) shape.setAttribute('opacity', '0.6');
    group.append(shape); view.svg.append(defs, group);
  }
  function paintImages() {
    renderFrame = 0; if (disposed) return;
    view.svg.replaceChildren();
    if (!enabled()) return;
    for (const record of annotations) if (record.kind === 'image') {
      const image = images.get(record.id); if (image?.isConnected) drawOne(record, image);
    }
    if (selectedImage?.isConnected) {
      const geometry = clippedGeometry(selectedImage);
      if (geometry) view.svg.append(svgElement('rect', { ...geometry.clipRect, fill: 'none', stroke: '#2563eb', 'stroke-width': 1, 'stroke-dasharray': '5 4' }));
      if (previewShape && geometry) view.svg.append(renderShape(previewShape, geometry, currentColor));
    }
    if (unsaved?.kind === 'image') {
      const match = resolveImage(unsaved.target);
      if (match.image) drawOne(unsaved, match.image, '-unsaved');
    }
  }
  function schedulePaint() { if (!renderFrame && !disposed) renderFrame = requestAnimationFrame(paintImages); }

  async function refresh() {
    const token = ++generation;
    let requestedUrl = currentUrl;
    try {
      const nextUrl = pageKey(location.href);
      if (nextUrl !== currentUrl) {
        notifications.resetScope(); passiveRetryCount = 0;
        clearTimeout(passiveRetryTimer); passiveRetryTimer = undefined;
        currentUrl = nextUrl; annotations = []; states = []; images.clear(); clearText(); exitDrawing();
        pageEnabled = false; modeReady = false; updatePalette();
        mutationObserver.disconnect(); resizeObserver.disconnect();
        undo.length = 0; redo.length = 0; rebinding = undefined; hideSelection();
      }
      requestedUrl = currentUrl;
      const [newSettings, pageMode] = await Promise.all([
        request<Settings>({ type: 'settings.get' }),
        request<PageMode>({ type: 'page.mode.get', pageUrl: requestedUrl }),
      ]);
      if (token !== generation || disposed) return;
      if (pageKey(location.href) !== requestedUrl) { queueRefresh(); return; }
      passiveRetryCount = 0; clearTimeout(passiveRetryTimer); passiveRetryTimer = undefined;
      if (settings.defaultColor !== newSettings.defaultColor || mode === 'idle') currentColor = newSettings.defaultColor;
      settings = newSettings;
      disabled = settings.disabledOrigins.includes(location.origin);
      pageEnabled = pageMode.enabled; modeReady = true; updatePalette();
      if (!enabled()) {
        mutationObserver.disconnect(); resizeObserver.disconnect();
        annotations = []; states = []; clearText(); images.clear(); exitDrawing(); hideSelection(); notifications.hide();
        publishStates(); return;
      }
      observeReadingPage();
      const records = await request<Annotation[]>({ type: 'annotations.list', pageUrl: requestedUrl });
      if (token !== generation || disposed) return;
      if (pageKey(location.href) !== requestedUrl) { queueRefresh(); return; }
      annotations = records; clearText(); resizeObserver.disconnect(); images.clear(); states = [];
      if (!enabled()) { exitDrawing(); publishStates(); return; }
      const groups = new Map<string, Range[]>();
      const resolveText = createTextResolver();
      const supportsHighlight = 'highlights' in CSS && typeof Highlight !== 'undefined';
      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        if (record.kind === 'text') {
          if (!supportsHighlight) states.push({ id: record.id, status: 'unsupported', reason: 'CSS Custom Highlight is unavailable' });
          else {
            const match = resolveText(record.target);
            states.push({ id: record.id, status: match.status, reason: match.reason });
            if (match.range) {
              textRanges.set(record.id, match.range);
              const group = groups.get(record.color) ?? []; group.push(match.range); groups.set(record.color, group);
            }
          }
        } else {
          const match = resolveImage(record.target);
          states.push({ id: record.id, status: match.status, reason: match.reason });
          if (match.image) { images.set(record.id, match.image); resizeObserver.observe(match.image); }
        }
        // Yield for large pages, while a newer refresh can cancel this work.
        if (i % 20 === 19) { await new Promise<void>(resolve => setTimeout(resolve, 0)); if (token !== generation || disposed) return;
          if (pageKey(location.href) !== requestedUrl) { queueRefresh(); return; } }
      }
      if (token !== generation || disposed) return;
      const rules: string[] = [];
      for (const [color, ranges] of groups) {
        const name = `web-ink-${color.slice(1)}`;
        CSS.highlights.set(name, new Highlight(...ranges)); highlightNames.add(name);
        rules.push(`::highlight(${name}) { background-color: ${color}99; color: inherit; }`);
      }
      highlightStyle.textContent = rules.join('\n');
      publishStates(); schedulePaint();
    } catch (error) {
      if (disposed || token !== generation) return;
      if ((error instanceof RequestError && error.code === 'PAGE_CHANGED') || pageKey(location.href) !== requestedUrl) {
        // Navigation races are expected background work, not a failed user save.
        // Retry a bounded number of times; never flood the page with an internal error.
        if (passiveRetryCount < 2 && !passiveRetryTimer) {
          passiveRetryCount++;
          passiveRetryTimer = setTimeout(() => { passiveRetryTimer = undefined; if (!disposed && !stopped) void refresh(); }, 300);
        }
        return;
      }
      if (!pageEnabled) { modeReady = true; updatePalette(); return; }
      notifications.show(label('暂时无法恢复此页标注，可刷新网页重试。', 'Annotations could not be restored. Reload this page to retry.'), {
        kind: 'error', key: `restore:${error instanceof RequestError ? error.code : 'unavailable'}`, passive: true,
        dismissLabel: label('关闭提示', 'Dismiss'),
      });
    }
  }
  function publishStates() {
    void request({ type: 'page.states', states, pageUrl: currentUrl }).catch(() => undefined);
  }
  function queueRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (!disposed && (enabled() || pageKey(location.href) !== currentUrl)) void refresh();
    }, 250);
  }
  function focusRecord(id?: string) {
    const range = id ? textRanges.get(id) : undefined;
    const image = id ? images.get(id) : undefined;
    if (range) {
      const node = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
      node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else if (image) image.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else toast(label('找不到原位置，可在侧栏选择重新定位。', 'Original location not found. Use Rebind in the sidebar.'), true);
    focusId = id; schedulePaint();
  }

  view.svg.addEventListener('pointerdown', e => {
    if (mode !== 'drawing' || !selectedImage || pendingSave || unsaved || e.button !== 0) return;
    const geometry = clippedGeometry(selectedImage); if (!geometry) return;
    const point = clientToImage(e.clientX, e.clientY, geometry); if (!point) return;
    e.preventDefault(); drawingPointer = e.pointerId; view.svg.setPointerCapture(e.pointerId);
    drawingPoints = [{ ...point, pressure: e.pressure || 0.5 }];
    previewShape = { kind: shapeKind, points: drawingPoints, width: 3 / geometry.imageRect.width };
  }, { signal });
  view.svg.addEventListener('pointermove', e => {
    if (drawingPointer !== e.pointerId || !selectedImage || !previewShape) return;
    const geometry = clippedGeometry(selectedImage); if (!geometry) return;
    const point = clientToImage(e.clientX, e.clientY, geometry); if (!point) return;
    if (shapeKind === 'pen') { if (drawingPoints.length < 2000) drawingPoints.push({ ...point, pressure: e.pressure || 0.5 }); }
    else drawingPoints = [drawingPoints[0]!, point];
    previewShape = { ...previewShape, points: drawingPoints }; schedulePaint();
  }, { signal });
  const endPointer = (e: PointerEvent) => {
    if (e.pointerId !== drawingPointer || !selectedImage || !previewShape) return;
    drawingPointer = undefined;
    if (view.svg.hasPointerCapture(e.pointerId)) view.svg.releasePointerCapture(e.pointerId);
    const shape = previewShape; previewShape = undefined;
    if (shape.points.length < 2) return;
    const a = shape.points[0]!, b = shape.points.at(-1)!;
    if (shape.kind !== 'pen' && Math.hypot(a.x - b.x, a.y - b.y) < 0.003) return;
    try {
      const record: ImageAnnotation = { ...baseRecord(currentColor), kind: 'image', target: captureImage(selectedImage), shape };
      void commit(record, true);
    } catch (error) { fail(error); }
  };
  view.svg.addEventListener('pointerup', endPointer, { signal });
  view.svg.addEventListener('pointercancel', () => { drawingPointer = undefined; previewShape = undefined; schedulePaint(); }, { signal });

  document.addEventListener('pointerdown', e => {
    if (!enabled() || e.composedPath().includes(view.host)) return;
    if (mode === 'choose-image') {
      const target = e.target;
      if (target instanceof HTMLImageElement) { e.preventDefault(); e.stopPropagation(); chooseImage(target); }
    } else if (mode === 'idle') hideSelection();
  }, { capture: true, signal });
  document.addEventListener('mouseup', e => {
    if (!enabled() || mode !== 'idle' || e.composedPath().includes(view.host)) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { hideSelection(); return; }
    const range = selection.getRangeAt(0);
    try { captureText(range); showPalette(range); } catch { hideSelection(); }
  }, { signal });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { exitDrawing(); hideSelection(); rebinding = undefined; return; }
    if (mode === 'idle' || e.composedPath().some(n => n instanceof HTMLElement && (n.matches('input,textarea') || n.isContentEditable))) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) void redoDrawing(); else void undoDrawing(); }
  }, { signal });
  window.addEventListener('scroll', () => {
    // A site may finish scrolling after mouseup (e.g. GitHub README hydration).
    // Reposition the palette instead of making an otherwise valid selection disappear.
    if (selectedRange && selectedRange.startContainer.isConnected && mode === 'idle') showPalette(selectedRange);
    else hideSelection();
    schedulePaint();
  }, { capture: true, passive: true, signal });
  window.addEventListener('resize', schedulePaint, { signal });
  window.addEventListener('popstate', queueRefresh, { signal });
  window.addEventListener('hashchange', queueRefresh, { signal });
  document.addEventListener('load', e => { if (e.target instanceof HTMLImageElement) queueRefresh(); }, { capture: true, signal });
  const resizeObserver = new ResizeObserver(schedulePaint);
  const mutationObserver = new MutationObserver(mutations => {
    const relevant = mutations.filter(m => !view.host.contains(m.target) && m.target !== highlightStyle &&
      !(m.target instanceof Element && m.target.closest('[data-web-ink]')));
    if (relevant.some(m => m.type !== 'attributes' || m.attributeName === 'src' || m.attributeName === 'srcset')) queueRefresh();
    if (relevant.length) schedulePaint();
  });
  function observeReadingPage() {
    mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'srcset', 'class', 'style'] });
  }
  const onMessage = (message: { type?: string; action?: string; id?: string }, _sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => {
    if (message.type === 'page.snapshot') { respond({ pageUrl: currentUrl, states, enabled: enabled() }); return false; }
    if (message.type === 'permissions.revoked') { stopped = true; clearText(); exitDrawing(); view.svg.replaceChildren(); mutationObserver.disconnect(); notifications.hide(); updatePalette(); }
    if (message.type === 'permissions.restored') { stopped = false; void refresh(); }
    if (message.type === 'annotations.changed' || message.type === 'settings.changed' || message.type === 'page.mode.changed') void refresh();
    if (message.type === 'page.action.execute') {
      if (message.action === 'refresh') void refresh();
      if (message.action === 'focus') void withPageEnabled(() => focusRecord(message.id));
      if (message.action === 'draw') { rebinding = undefined; void withPageEnabled(startDrawing); }
      if (message.action === 'rebind') {
        const record = annotations.find(a => a.id === message.id);
        if (record) {
          rebinding = record;
          if (record.kind === 'image') startDrawing();
          else { exitDrawing(); toast(label('重新选择原文，再点击高亮颜色以绑定。', 'Select the intended text and apply a color to rebind.')); }
        }
      }
      respond(true);
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  void refresh();
  return () => {
    disposed = true; generation++; observers.abort(); mutationObserver.disconnect(); resizeObserver.disconnect();
    clearTimeout(refreshTimer); clearTimeout(passiveRetryTimer); cancelAnimationFrame(renderFrame); clearText(); notifications.dispose(); palette.dispose();
    chrome.runtime.onMessage.removeListener(onMessage); view.host.remove(); highlightStyle.remove();
    delete (window as InkWindow).__webInkActive;
  };
}
