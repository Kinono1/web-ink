import { HASH, TOKEN, publicSource, baseRecord, reader, settle, mount, chooseLocalPdf, button, click, openNotes, selectPage, puts, io } from "../helpers/pdf-reader";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { rememberPdfPaperReopen } from "../../src/pdf/paper-identity";

function ieeeHandoff(expiresAt = Date.now() + 60_000) {
  return {
    token: TOKEN,
    tabId: 8,
    returnUrl: "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1",
    accessMode: "site-session" as const,
    allowedOrigin: "https://ieeexplore.ieee.org",
    expiresAt,
  };
}

it('consumes the prepared IEEE session without downloading again or persisting a ticket', async () => {
  const pageUrl = 'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=11643626';
  const download = 'https://ieeexplore.ieee.org/download?ticket=private';
  reader.handoff = { token: TOKEN, tabId: 8, returnUrl: pageUrl, sourceUrl: download, accessMode: 'site-session', allowedOrigin: 'https://ieeexplore.ieee.org', expiresAt: Date.now() + 600_000 };
  await mount(`?handoff=${TOKEN}`, false);
  expect(io.ieeeReads).toEqual([{ pageUrl, sourceUrl: download }]);
  expect(io.remoteReads).toEqual([]);
  expect(reader.host.querySelector('.pdf-page')).not.toBeNull();
  expect(location.href).not.toContain('private');
  expect(new URL(location.href).searchParams.get('source')).toBe('https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626');
  expect(reader.messages.filter(m => m.type === 'pdf.handoff.get')).toHaveLength(3);
});

it('does not reuse IEEE credentials for a different manually opened source on refresh', async () => {
  reader.handoff = ieeeHandoff();
  await mount(`?handoff=${TOKEN}&source=${encodeURIComponent('https://papers.example.test/other.pdf')}&document=${HASH}`, false);
  expect(io.ieeeReads).toEqual([]);
  expect(io.remoteReads).toEqual(['https://papers.example.test/other.pdf']);
  expect(reader.host.querySelector('.pdf-name')?.textContent).toBe('other.pdf');
});

it('keeps IEEE access explicit when permission is missing or rejected', async () => {
  reader.handoff = ieeeHandoff();
  vi.mocked(chrome.permissions.contains as (details: chrome.permissions.Permissions) => Promise<boolean>).mockResolvedValue(false);
  vi.mocked(chrome.permissions.request as (details: chrome.permissions.Permissions) => Promise<boolean>).mockResolvedValue(false);
  await mount(`?handoff=${TOKEN}`, false);
  expect(chrome.permissions.request).not.toHaveBeenCalled();
  expect(io.ieeeReads).toEqual([]);
  await click('允许访问 IEEE 并重试');
  expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ['https://ieeexplore.ieee.org/*'] });
  expect(io.ieeeReads).toEqual([]);
  expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain('未授予');
  expect([...reader.host.querySelectorAll('button')].some(b => b.textContent === '返回原阅读器')).toBe(true);
});

it('rechecks IEEE expiry after a permission prompt before fetching', async () => {
  reader.handoff = ieeeHandoff();
  vi.mocked(chrome.permissions.contains as (details: chrome.permissions.Permissions) => Promise<boolean>).mockResolvedValue(false);
  vi.mocked(chrome.permissions.request as (details: chrome.permissions.Permissions) => Promise<boolean>).mockImplementation(async () => { reader.handoff!.expiresAt = 0; return true; });
  await mount(`?handoff=${TOKEN}`, false);
  await click('允许访问 IEEE 并重试');
  expect(io.ieeeReads).toEqual([]);
  expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain('登录读取授权已过期');
});

it('revokes IEEE session access before opening a manually selected local file', async () => {
  reader.handoff = ieeeHandoff();
  await mount(`?handoff=${TOKEN}`, false);
  await click('更多');
  await click('打开其他文件');
  const input = reader.host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File(['%PDF-'], 'manual.pdf')] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await settle();
  expect(reader.messages).toContainEqual({ type: 'pdf.handoff.revoke', token: TOKEN });
  expect(reader.host.querySelector('.pdf-name')?.textContent).toBe('manual.pdf');
});

it('does not try public fetch when an IEEE reader loses its session handoff', async () => {
  reader.handoff = null;
  await mount(`?handoff=${TOKEN}&source=${encodeURIComponent('https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1')}&document=${HASH}`, false);
  expect(io.ieeeReads).toEqual([]);
  expect(io.remoteReads).toEqual([]);
  expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain('返回 IEEE');
});

it.each([['network', '返回 IEEE'], ['login-required', '返回 IEEE']] as const)('returns to IEEE after a prepared session becomes unavailable (%s)', async (failure, label) => {
  reader.handoff = ieeeHandoff();
  io.ieeeFailure = failure;
  await mount(`?handoff=${TOKEN}`, false);
  expect([...reader.host.querySelectorAll('button')].some(b => b.textContent === label)).toBe(true);
  expect([...reader.host.querySelectorAll('button')].some(b => b.textContent === '允许访问 IEEE 并重试')).toBe(false);
});

it('revokes an IEEE grant on pagehide while retaining saved annotations', async () => {
  reader.handoff = ieeeHandoff();
  await mount(`?handoff=${TOKEN}`, false);
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  await settle();
  expect(reader.messages).toContainEqual({ type: 'pdf.handoff.revoke', token: TOKEN });
  expect(reader.messages.some(m => m.type === 'annotations.delete')).toBe(false);
});

it('opens the IEEE paper source instead of pretending a library wrapper is a public PDF', async () => {
  reader.handoff = null;
  await mount(`?source=${encodeURIComponent('https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1')}&document=${HASH}`, false);
  expect(io.remoteReads).toEqual([]);
  expect(io.ieeeReads).toEqual([]);
  expect([...reader.host.querySelectorAll('button')].some(b => b.textContent === '返回 IEEE')).toBe(true);
});

it('does not read an expired IEEE session but keeps the return action', async () => {
  reader.handoff = ieeeHandoff(Date.now() - 1);
  await mount(`?handoff=${TOKEN}`, false);
  expect(io.ieeeReads).toEqual([]);
  expect(reader.host.textContent).toContain('登录读取授权已过期');
  expect(reader.host.textContent).toContain('返回原阅读器');
});

it('keeps the local-file entry focused on choosing a file without asking for a URL', async () => {
  await mount('?open=local', false);
  expect(reader.host.querySelector('input[type="file"]')).not.toBeNull();
  expect(reader.host.querySelector('input[type="url"]')).toBeNull();
  expect(reader.host.querySelector('h1')?.textContent).toBe('选择电脑上的 PDF');
  expect(io.remoteReads).toEqual([]);
  await chooseLocalPdf(new File(['%PDF-'], 'local.pdf', { type: 'application/pdf' }));
  expect(reader.host.querySelector('.pdf-name')?.textContent).toBe('local.pdf');
  expect(io.remoteReads).toEqual([]);
});

it('retains URL input in the generic PDF entry', async () => {
  await mount('', false);
  expect(reader.host.querySelector('input[type="file"]')).not.toBeNull();
  expect(reader.host.querySelector('input[type="url"]')).not.toBeNull();
});

it("uses PDF metadata for the reader and new annotations without renaming old records", async () => {
  io.metadataTitle = "A scientific paper";
  io.metadataDoi = "10.1109/TII.2026.3716639";
  reader.records = [baseRecord()];
  await mount();
  const display = "A scientific paper — DOI: 10.1109/TII.2026.3716639";
  expect(reader.host.querySelector(".pdf-name")?.textContent).toBe(display);
  await selectPage();
  await click("高亮 #facd5a");
  const write = puts().at(-1)!;
  if (write.type !== "annotations.put") throw Error("Missing annotation write");
  expect(write.annotation.pageTitle).toBe(display);
  if (write.annotation.kind !== "pdf-text") throw Error("Not a text annotation");
  expect(write.annotation.target.fileName).toBe(display);
  expect(reader.records.find(record => record.id === "saved-highlight")?.pageTitle).toBe("fixture.pdf");
});

it("keeps a PDF usable when reading its metadata fails", async () => {
  io.metadataFailure = true;
  await mount();
  expect(reader.host.querySelector(".pdf-name")?.textContent).toBe("fixture.pdf");
  await selectPage();
  expect(reader.host.querySelector(".pdf-selection")).not.toBeNull();
});

describe("PDF reader workspace", () => {
  it("saves the explicit metadata DOI as the source for new signed-in IEEE annotations", async () => {
    io.metadataDoi = "10.1109/TII.2026.3716639";
    reader.handoff = { token: TOKEN, tabId: 8, returnUrl: "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626",
      accessMode: "site-session", allowedOrigin: "https://ieeexplore.ieee.org", expiresAt: Date.now() + 60000 };
    await mount(`?handoff=${TOKEN}`, false);
    await selectPage();
    await click("高亮 #facd5a");
    const saved = puts()[0]?.annotation;
    expect(saved?.kind === "pdf-text" && saved.target.sourceUrl).toBe("https://doi.org/10.1109/TII.2026.3716639");
  });

  it("restores the selected legacy record page after a fresh IEEE login handoff", async () => {
    const original = baseRecord();
    const saved = { ...original, target: { ...original.target, pageNumber: 3,
      sourceUrl: "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626" } };
    reader.records = [saved];
    await rememberPdfPaperReopen(saved.target, undefined, 8);
    reader.handoff = { token: TOKEN, tabId: 8, returnUrl: saved.target.sourceUrl,
      accessMode: "site-session", allowedOrigin: "https://ieeexplore.ieee.org", expiresAt: Date.now() + 60000 };
    await mount(`?handoff=${TOKEN}`, false);
    expect(reader.host.querySelector<HTMLInputElement>('[aria-label="页码"]')?.value).toBe("3");
    expect(reader.host.querySelector('[data-pdf-annotation="saved-highlight"]')).not.toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it("offers previous annotations without overlaying them on a changed IEEE download", async () => {
    const original = baseRecord();
    const saved = { ...original, target: { ...original.target,
      sourceUrl: "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11643626" } };
    await rememberPdfPaperReopen(saved.target, undefined, 8);
    io.hash = "b".repeat(64);
    reader.handoff = { token: TOKEN, tabId: 8, returnUrl: saved.target.sourceUrl,
      accessMode: "site-session", allowedOrigin: "https://ieeexplore.ieee.org", expiresAt: Date.now() + 60000 };
    await mount(`?handoff=${TOKEN}`, false);
    expect(reader.host.textContent).toContain("旧标注已保留");
    expect([...reader.host.querySelectorAll("button")].some(button => button.textContent === "查看之前的标注")).toBe(true);
    expect(reader.host.querySelector('[data-pdf-annotation="saved-highlight"]')).toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it("autoloads an allowed public source on refresh without the consumed open flag", async () => {
    await mount(`?source=${encodeURIComponent(publicSource)}&document=${HASH}`, false);
    expect(io.remoteReads).toEqual([publicSource]);
    expect(reader.host.querySelector(".pdf-name")?.textContent).toBe("paper.pdf");
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });

  it("does not reopen handoff A over a locally selected B after refresh", async () => {
    await mount(`?handoff=${TOKEN}&document=${HASH}`, false);
    expect(io.remoteReads).toHaveLength(0);
    expect(reader.host.textContent).toContain("重新选择");
    expect(reader.messages).toContainEqual({ type: "pdf.handoff.get", token: TOKEN });
  });

  it("keeps the last local document URL as fallback truth after another source fails", async () => {
    reader.handoff = null;
    await mount(`?handoff=${TOKEN}&source=${encodeURIComponent(publicSource)}`, false);
    await click("更多");
    await click("打开其他文件");
    io.hash = "b".repeat(64);
    await chooseLocalPdf(new File(["%PDF-"], "local-b.pdf"));
    expect(new URL(location.href).searchParams.has("source")).toBe(false);
    await click("更多");
    await click("打开其他文件");
    const input = reader.host.querySelector<HTMLInputElement>('input[type="url"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "http://invalid.example.test/a.pdf");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(reader.host.querySelector('button[aria-label="打开 PDF 来源"]')).toBeNull();
    expect(reader.host.textContent).not.toContain("打开 PDF 来源");
    expect(reader.host.textContent).toContain("重新选择原来的 PDF");
    expect(new URL(location.href).searchParams.get("document")).toBe("b".repeat(64));
  });

  it("offers an accurate public fallback when the original session has expired", async () => {
    reader.handoff = null;
    await mount(`?handoff=${TOKEN}&source=${encodeURIComponent(publicSource)}`, false);
    expect(reader.host.textContent).toContain("打开 PDF 来源");
    expect(reader.messages.some((message) => message.type === "pdf.returnOriginal")).toBe(false);
  });

  it.each(["NAVIGATION_FAILED", "STORAGE_UNAVAILABLE", "CONTEXT_UNAVAILABLE", "PAGE_CHANGED", undefined])(
    "keeps the original return action retryable after %s", async code => {
      await mount(`?handoff=${TOKEN}`);
      const readerUrl = location.href;
      reader.returnError = "Temporary return failure";
      reader.returnErrorCode = code;
      await click("返回原阅读器");
      expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain("Temporary return failure");
      expect(location.href).toBe(readerUrl);
      expect(button("返回原阅读器").disabled).toBe(false);

      reader.returnError = "";
      await click("返回原阅读器");
      expect(reader.messages.filter(message => message.type === "pdf.returnOriginal")).toEqual([
        { type: "pdf.returnOriginal", token: TOKEN }, { type: "pdf.returnOriginal", token: TOKEN },
      ]);
    },
  );

  it.each(["PDF_SOURCE_UNAVAILABLE", "FORBIDDEN"])("replaces an invalid return session with explicit recovery after %s", async code => {
    await mount(`?handoff=${TOKEN}`);
    reader.returnError = "Return session is invalid";
    reader.returnErrorCode = code;
    await click("返回原阅读器");
    expect(reader.host.querySelector('[role="alert"]')?.textContent).toContain("Return session is invalid");
    expect([...reader.host.querySelectorAll("button")].some(node => node.getAttribute("aria-label") === "返回原阅读器" || node.textContent?.trim() === "返回原阅读器")).toBe(false);
    await click("重新选择 PDF");
    expect(reader.host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("打开其他 PDF");
    expect(reader.messages.filter(message => message.type === "pdf.returnOriginal")).toEqual([{ type: "pdf.returnOriginal", token: TOKEN }]);
  });

  it("shows an oversized-image failure on its page while preserving notes and the return path", async () => {
    io.pageCount = 2;
    io.rejectOversizedImage = true;
    reader.records = [{ ...baseRecord(), note: "keep this saved note" }];

    await mount(`?handoff=${TOKEN}`);

    expect(io.documentOptions.at(-1)).toMatchObject({
      maxImageSize: 16777216,
      canvasMaxAreaInBytes: 67108864,
      stopAtErrors: true,
      verbosity: 0,
    });
    const failedPage = reader.host.querySelector<HTMLElement>('[data-page="1"] .pdf-page')!;
    const healthyPage = reader.host.querySelector<HTMLElement>('[data-page="2"] .pdf-page')!;
    expect(failedPage.dataset.ready).toBe("false");
    expect(failedPage.querySelector('[role="alert"]')?.textContent).toContain("第 1 页");
    expect(failedPage.querySelector('[role="alert"]')?.textContent).toContain("图片过大");
    expect(failedPage.querySelector("svg")).toBeNull();
    expect(failedPage.querySelector(".pdf-area-capture")).toBeNull();
    expect(healthyPage.dataset.ready).toBe("true");

    await openNotes();
    expect(reader.host.querySelector(".pdf-notes")?.textContent).toContain("keep this saved note");
    expect(button("返回原阅读器")).toBeTruthy();
    expect(reader.records.map((record) => record.id)).toEqual(["saved-highlight"]);
    expect(puts()).toHaveLength(0);
  });
});
