import { PdfResponseError } from "./pdf-source";

export type IeeePdfPhase = "identify" | "wrapper" | "file" | "validate";export type IeeePdfSourceKind = "unknown" | "wrapper" | "file";

export interface IeeePdfDiagnostic {
  id: string; version: 1; phase: IeeePdfPhase; elapsedMs: number; status?: number; mime?: "application/pdf" | "application/x-pdf" | "application/octet-stream" | "text/html" | "application/xhtml+xml"; sourceKind: IeeePdfSourceKind;
}
interface IeeeDiagnosticInput {
  id: string; phase: IeeePdfPhase; startedAt: number; now?: number; status?: number; mime?: string; sourceKind?: string;
}
const knownMimes = new Set<IeeePdfDiagnostic["mime"]>([
  "application/pdf",
  "application/x-pdf",
  "application/octet-stream",
  "text/html",
  "application/xhtml+xml",
]);
function safeElapsedMs(startedAt: number, now: number): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor(now - startedAt));
}
function safeMime(raw: string | undefined): IeeePdfDiagnostic["mime"] | undefined {
  const value = raw?.split(";", 1)[0]?.trim().toLowerCase();
  return value && knownMimes.has(value as IeeePdfDiagnostic["mime"])
    ? value as IeeePdfDiagnostic["mime"]
    : undefined;
}

export function createIeeePdfDiagnostic(input: IeeeDiagnosticInput): IeeePdfDiagnostic {
  const diagnostic: IeeePdfDiagnostic = {
    id: input.id,
    version: 1,
    phase: input.phase,
    elapsedMs: safeElapsedMs(input.startedAt, input.now ?? Date.now()),
    sourceKind: input.sourceKind === "wrapper" || input.sourceKind === "file"
      ? input.sourceKind
      : "unknown",
  };
  if (Number.isInteger(input.status) && input.status! >= 100 && input.status! <= 599)
    diagnostic.status = input.status;
  const mime = safeMime(input.mime);
  if (mime) diagnostic.mime = mime;
  return diagnostic;
}

export function createIeeePdfReadId(): string {
  return crypto.randomUUID();
}

export function pdfPreparationLabel(phase: string | undefined, language: string): string {
  const labels: Record<string, [string, string]> = {
    identify: ['正在识别来源…', 'Identifying source…'],
    wrapper: ['正在读取来源页面…', 'Reading source page…'],
    file: ['正在读取 PDF…', 'Reading PDF…'],
    validate: ['正在校验 PDF…', 'Checking PDF…'],
    opening: ['正在打开阅读器…', 'Opening reader…'],
  };
  return (labels[phase ?? 'identify'] ?? labels.identify)![language === 'zh-CN' ? 0 : 1];
}

export function ieeeFailureMessage(code: string | undefined, language: string): string | undefined {
  const messages: Record<string, [string, string]> = {
    'source-hidden': ['没有找到 PDF 全文来源，原页面已保留。请从 IEEE 论文页重新打开全文。', 'Full-text PDF source not found. Original page retained. Open the full text from the IEEE paper page.'],
    'site-permission': ['需要允许访问 IEEE 后重试。', 'Allow access to IEEE, then retry.'],
    'login-required': ['登录状态不可用，原 PDF 已保留。请回论文页登录后重试。', 'Sign-in is unavailable. Original PDF retained. Sign in on the paper page, then retry.'],
    'access-restricted': ['IEEE 拒绝访问，原 PDF 已保留。请在论文页确认访问权限。', 'IEEE denied access. Original PDF retained. Check access on the paper page.'],
    'redirect-blocked': ['读取过程中需要跳转，原 PDF 已保留。请回论文页重新打开全文。', 'Reading requires a redirect. Original PDF retained. Reopen full text from the paper page.'],
    'not-pdf': ['没有取得有效的 PDF 全文，原页面已保留。请回论文页重新打开全文。', 'No valid full-text PDF was received. Original page retained. Reopen full text from the paper page.'],
    network: ['读取未完成，原因尚未确认。原 PDF 已保留，可以重试或查看诊断详情。', 'Reading did not finish; the cause is not confirmed. Original PDF retained. Retry or view diagnostic details.'],
  };
  const reason = code?.startsWith('IEEE_') ? code.slice(5) : undefined;
  const message = reason ? messages[reason] : undefined;
  return message?.[language === 'zh-CN' ? 0 : 1];
}

export function formatIeeeDiagnostic(diagnostic: IeeePdfDiagnostic, version: string): string {
  return JSON.stringify({ extensionVersion: version, id: diagnostic.id, schemaVersion: 1,
    phase: diagnostic.phase, elapsedMs: diagnostic.elapsedMs, sourceKind: diagnostic.sourceKind,
    ...(diagnostic.status !== undefined ? { status: diagnostic.status } : {}),
    ...(diagnostic.mime ? { mime: diagnostic.mime } : {}),
  }, null, 2);
}

export type IeeePdfReason =
  | "source-hidden"
  | "site-permission"
  | "login-required"
  | "access-restricted"
  | "redirect-blocked"
  | "not-pdf"
  | "network";
const failureMessages: Record<IeeePdfReason, string> = {
  "source-hidden": "尚未找到文件来源 / PDF source is not visible.",
  "site-permission": "需要允许访问 IEEE / Grant access to IEEE first.",
  "login-required": "登录状态不可用，请回原页面登录后重试 / Return to IEEE to sign in, then retry.",
  "access-restricted": "来源拒绝访问，请回原页面确认访问权限 / The source denied access; return to the original page to confirm access.",
  "redirect-blocked": "该来源需要跳转，请在原页面下载后选择文件 / Download from the original page, then choose the file.",
  "not-pdf": "返回内容不是 PDF / The response is not a PDF.",
  "network": "网络读取失败，可能是网络问题或网站跳转 / Network read failed; a network problem or a site redirect may be involved.",
};

export class IeeePdfError extends Error {
  readonly stage?: PdfResponseError["stage"];
  readonly diagnostic: IeeePdfDiagnostic;
  constructor(
    readonly reason: IeeePdfReason,
    responseError?: PdfResponseError,
    diagnostic = createIeeePdfDiagnostic({ id: createIeeePdfReadId(), phase: "identify", startedAt: 0, now: 0 })) {
    super(responseError?.message ?? failureMessages[reason]);
    this.name = "IeeePdfError";
    this.stage = responseError?.stage;
    this.diagnostic = diagnostic;
  }
}

/** Only this issuer can participate in an IEEE session handoff. */
export function ieeeSourceUrl(raw: string, base?: string): URL {
  try {
    // URL drops empty userinfo; reject it before normalization as well.
    const value = raw.trim();
    const absolute = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
    const authority = value.match(/^(?:https:)?\/\/([^/?#]+)/i)?.[1];
    if ((absolute && !authority) || authority?.includes("@") || /[\u0000-\u001f\u007f\\]/.test(value)) throw Error();
    const url = new URL(raw, base);
    if (url.origin !== IEEE_ORIGIN || url.username || url.password) throw Error();
    url.hash = "";
    return url;
  } catch {
    throw new IeeePdfError("source-hidden");
  }
}

const IEEE_ORIGIN = "https://ieeexplore.ieee.org";
