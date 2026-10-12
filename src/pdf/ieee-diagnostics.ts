export type IeeePdfPhase = "identify" | "wrapper" | "file" | "validate";
export type IeeePdfSourceKind = "unknown" | "wrapper" | "file";

export interface IeeePdfDiagnostic {
  id: string;
  version: 1;
  phase: IeeePdfPhase;
  elapsedMs: number;
  status?: number;
  mime?: "application/pdf" | "application/x-pdf" | "application/octet-stream" | "text/html" | "application/xhtml+xml";
  sourceKind: IeeePdfSourceKind;
}

interface IeeeDiagnosticInput {
  id: string;
  phase: IeeePdfPhase;
  startedAt: number;
  now?: number;
  status?: number;
  mime?: string;
  sourceKind?: string;
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
