import { pdfPreparationLabel } from "../core/ieee-contract";
import type { Language, PdfTabContext } from "../core/model";
import { getPdfContext } from "../core/pdf-context";
import type { PaletteMenuItem } from "./palette-menu";

type Candidate = PdfTabContext["candidates"][number];
type LabeledCandidate = { candidate: Candidate; sourceLabel: string };

interface PaletteItemsOptions {
  language: Language;
  pageUrl: string;
  context?: PdfTabContext;
  enabled: boolean;
  selectionToolsEnabled: boolean;
  blocked: boolean;
  opening: boolean;
  preparationPhase?: string;
}

export function paletteItems(options: PaletteItemsOptions): PaletteMenuItem[] {
  const { context, language, pageUrl, enabled, selectionToolsEnabled, blocked, opening, preparationPhase } = options;
  const chinese = language === "zh-CN";
  const items = context ? pdfItems(context, chinese) : [];
  if (context?.reason === "not-pdf" && items.length === 0 && !getPdfContext(pageUrl)) {
    if (enabled && !selectionToolsEnabled) {
      items.push({ action: "selection-tools", icon: "highlight", primary: true, disabled: blocked,
        label: chinese ? "开启选字工具" : "Enable selection tools" });
    }
    const label = enabled
      ? (chinese ? "关闭本页标注" : "Disable page annotations")
      : (chinese ? "开启本页标注" : "Enable page annotations");
    items.push({ action: "toggle", icon: "highlight", primary: true, disabled: blocked, label });
  }
  items.push(
    { action: "sidebar", icon: "note", label: chinese ? "本篇标注" : "Page annotations" },
    { action: "library", icon: "library", label: chinese ? "资料库" : "Library" },
    { action: "local-pdf", icon: "pdf", label: chinese ? "打开本地 PDF…" : "Open local PDF…" },
  );
  if (opening && context?.publisher === "ieee") {
    items[0]!.label = pdfPreparationLabel(preparationPhase, language);
    items.push({ action: "cancel", icon: "close", label: chinese ? "取消读取" : "Cancel reading" });
  }
  return items;
}

function pdfItems(context: PdfTabContext, chinese: boolean): PaletteMenuItem[] {
  const annotate = chinese ? "标注当前 PDF" : "Annotate this PDF";
  const open = chinese ? "打开" : "Open";
  if (context.publisher !== "ieee") {
    return labeledCandidates(context.candidates).map(({ candidate, sourceLabel }) => ({
      action: "open-pdf", icon: "pdf", primary: true,
      label: context.candidates.length === 1 ? annotate : `${open} ${sourceLabel}`,
      candidateUrl: candidate.url,
    }));
  }
  const sessionCandidates = context.candidates.filter(isIeeeCandidate);
  const publicCandidates = context.candidates.filter(candidate => !isIeeeCandidate(candidate));
  const sessionItems: PaletteMenuItem[] = sessionCandidates.length
    ? labeledCandidates(sessionCandidates).map(({ candidate, sourceLabel }) => ({
        action: "open-ieee", icon: "pdf", primary: true,
        label: sessionCandidates.length === 1 ? annotate : `${annotate}: ${sourceLabel}`,
        candidateUrl: candidate.url,
      }))
    : [{ action: "open-ieee", icon: "pdf", primary: true, label: annotate }];
  return sessionItems.concat(labeledCandidates(publicCandidates).map(({ candidate, sourceLabel }) => ({
    action: "open-pdf", icon: "pdf", primary: true, label: `${open} ${sourceLabel}`, candidateUrl: candidate.url,
  })));
}

function isIeeeCandidate(candidate: Candidate): boolean {
  const url = new URL(candidate.url);
  return url.origin === "https://ieeexplore.ieee.org" && !url.username && !url.password;
}

function labeledCandidates(candidates: Candidate[]): LabeledCandidate[] {
  const named = candidates.map(candidate => {
    const url = new URL(candidate.url);
    return { candidate, filename: url.pathname.split("/").pop() || url.hostname };
  });
  const counts = new Map<string, number>();
  for (const { filename } of named) counts.set(filename, (counts.get(filename) ?? 0) + 1);
  return named.map(({ candidate, filename }) => ({
    candidate,
    sourceLabel: (counts.get(filename) ?? 0) > 1 ? `${filename} · ${candidate.url}` : filename,
  }));
}
