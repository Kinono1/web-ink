export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export class PdfResponseError extends Error {
  constructor(readonly stage: "size-limit" | "length-mismatch", maxBytes = MAX_PDF_BYTES) {
    super(stage === "length-mismatch"
      ? "PDF length does not match Content-Length."
      : maxBytes === MAX_PDF_BYTES
        ? "PDF 超过 50 MiB / PDF exceeds 50 MiB."
        : "Response exceeds byte limit.");
    this.name = "PdfResponseError";
  }
}
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
export async function readRemotePdf(raw: string, signal: AbortSignal): Promise<Uint8Array> {
  const url = pdfSourceUrl(raw);
  if (!(await chrome.permissions.contains({ origins: [`${url.origin}/*`] })))
    throw Error("请先允许访问此 PDF 网站 / Grant access to this PDF site first.");
  const response = await fetch(url, {
    signal, credentials: "omit",
    // Revalidate before reuse so repeated reads need not transfer an unchanged
    // public PDF; file identity still comes from the verified response bytes.
    cache: "no-cache", redirect: "error",
  });
  const finalUrl = pdfSourceUrl(response.url || url.href);
  if ( !(await chrome.permissions.contains({ origins: [`${finalUrl.origin}/*`] })) )
    throw Error("重定向网站尚未授权 / Redirected PDF site is not authorized.");
  return verifyPdf(await readResponseBytes(response));
}

/** Shared byte limits and Content-Length validation, without a fetch policy. */
export async function readResponseBytes(response: Response, maxBytes = MAX_PDF_BYTES,
  onBodyBytes?: (byteLength: number) => void,
): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw Error(`PDF 读取失败 / PDF request failed (${response.status}).`);
  const encoding = response.headers
    .get("content-encoding")
    ?.trim()
    .toLowerCase();
  const rawLength = response.headers.get("content-length")?.trim();
  const contentLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
  // Fetch exposes decoded body chunks. A compressed Content-Length therefore is
  // not a safe allocation size nor a proof of the decoded-size limit.
  const identity = !encoding || encoding === "identity";
  if (identity && contentLength !== undefined && contentLength > maxBytes ) {
    await response.body.cancel();
    throw new PdfResponseError("size-limit", maxBytes);
  }
  if (identity && contentLength !== undefined)
    return readExact(response.body, contentLength, onBodyBytes);
  return readBounded(response.body, maxBytes, onBodyBytes);
}

async function readExact(body: ReadableStream<Uint8Array>, length: number,
  onBodyBytes?: (byteLength: number) => void,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const bytes = new Uint8Array(length);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length) onBodyBytes?.(value.length);
      if (offset + value.length > length)
        throw new PdfResponseError("length-mismatch");
      bytes.set(value, offset);
      offset += value.length;
    }
    if (offset !== length)
      throw new PdfResponseError("length-mismatch");
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readBounded(body: ReadableStream<Uint8Array>, maxBytes: number,
  onBodyBytes?: (byteLength: number) => void,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length) onBodyBytes?.(value.length);
      size += value.length;
      if (size > maxBytes)
        throw new PdfResponseError("size-limit", maxBytes);
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
  return bytes;
}
export async function pdfHash(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    ), (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
