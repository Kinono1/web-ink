export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export function pdfSourceUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password)
    throw Error("仅支持公开 HTTPS PDF / Only public HTTPS PDFs are supported.");
  url.hash = "";
  return url;
}
export async function readLocalPdf(file: File): Promise<Uint8Array> {
  if (file.size > MAX_PDF_BYTES)
    throw Error("PDF 超过 50 MiB / PDF exceeds 50 MiB.");
  return verifyPdf(new Uint8Array(await file.arrayBuffer()));
}
export function verifyPdf(bytes: Uint8Array): Uint8Array {
  if (bytes.length > MAX_PDF_BYTES)
    throw Error("PDF 超过 50 MiB / PDF exceeds 50 MiB.");
  // Some valid files have a short binary prefix before the PDF header.
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-"))
    throw Error("文件不是有效 PDF / The response is not a PDF.");
  return bytes;
}
export async function readRemotePdf(
  raw: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const url = pdfSourceUrl(raw);
  if (!(await chrome.permissions.contains({ origins: [`${url.origin}/*`] })))
    throw Error(
      "请先允许访问此 PDF 网站 / Grant access to this PDF site first.",
    );
  const response = await fetch(url, {
    signal,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  const finalUrl = pdfSourceUrl(response.url || url.href);
  if (
    !(await chrome.permissions.contains({ origins: [`${finalUrl.origin}/*`] }))
  )
    throw Error("重定向网站尚未授权 / Redirected PDF site is not authorized.");
  if (!response.ok || !response.body)
    throw Error(`PDF 读取失败 / PDF request failed (${response.status}).`);
  if (Number(response.headers.get("content-length")) > MAX_PDF_BYTES) {
    await response.body.cancel();
    throw Error("PDF 超过 50 MiB / PDF exceeds 50 MiB.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PDF_BYTES)
        throw Error("PDF 超过 50 MiB / PDF exceeds 50 MiB.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return verifyPdf(bytes);
}
export async function pdfHash(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
