import { vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import type { PdfPage as PdfPageComponent } from "../../src/pdf/PdfPage";

type PdfPageProps = ComponentProps<typeof PdfPageComponent>;

const io = vi.hoisted(() => ({
  hash: "a".repeat(64),
  pageCount: 1000,
  remoteReads: [] as string[],
  ieeeReads: [] as Array<{ pageUrl: string; sourceUrl?: string }>,
  ieeeFailure: undefined as "network" | "login-required" | undefined,
  pagesRead: [] as number[],
  documentOptions: [] as Record<string, unknown>[],
  rejectOversizedImage: false,
  renderGates: {} as Record<number, Promise<unknown> | undefined>,
  parseGate: undefined as Promise<unknown> | undefined,
  metadataTitle: "",
  metadataDoi: "",
  metadataFailure: false,
  annotationsRead: [] as number[],
  renderedPages: [] as number[],
  nativeByPage: {} as Record<number, unknown[]>,
  annotationGates: {} as Record<number, Promise<unknown[]> | undefined>,
  dataReads: 0,
}));
const exportIo = vi.hoisted(() => ({
  writer: vi.fn(), verify: vi.fn(),
}));
vi.mock("../../src/pdf/export-client", () => ({ exportPdfInWorker: exportIo.writer }));
vi.mock("../../src/pdf/export-verify", () => ({ verifyPdfExport: exportIo.verify }));
const pageRenderMetrics = vi.hoisted(() => ({
  renders: [] as Array<{ page: number }>,
}));
// PERF HARNESS: invokes the real PdfPage render function directly. If a
// candidate exports React.memo(PdfPage, compare), re-wrap this counter with
// the identical comparator so a memo bailout does not increment the metric.
vi.mock("../../src/pdf/PdfPage", async (original) => {
  const actual = await original<typeof import("../../src/pdf/PdfPage")>();
  const React = await import("react");
  const exported = actual.PdfPage as unknown as {
    type?: (props: PdfPageProps) => ReactNode;
    compare?: ((previous: Readonly<PdfPageProps>, next: Readonly<PdfPageProps>) => boolean) | null;
  };
  const render = exported.type ?? actual.PdfPage;
  function MeasuredPdfPage(props: PdfPageProps) {
    pageRenderMetrics.renders.push({ page: props.number });
    return render(props);
  }
  const PdfPage = exported.type
    ? React.memo(MeasuredPdfPage, exported.compare ?? undefined)
    : MeasuredPdfPage;
  return { ...actual, PdfPage };
});
const noteRenderMetrics = vi.hoisted(() => ({ renders: [] as string[] }));
vi.mock("../../src/pdf/PdfNote", async (original) => {
  const actual = await original<typeof import("../../src/pdf/PdfNote")>();
  const React = await import("react");
  type Props = ComponentProps<typeof actual.PdfNote>;
  const exported = actual.PdfNote as unknown as {
    type?: (props: Props) => ReactNode;
    compare?: ((previous: Readonly<Props>, next: Readonly<Props>) => boolean) | null;
  };
  const render = exported.type ?? actual.PdfNote;
  function MeasuredPdfNote(props: Props) {
    noteRenderMetrics.renders.push(props.record.id);
    return render(props);
  }
  return { ...actual, PdfNote: exported.type ? React.memo(MeasuredPdfNote, exported.compare ?? undefined) : MeasuredPdfNote };
});
vi.mock('../../src/pdf/ieee', async (original) => {
  const actual = await original<typeof import('../../src/pdf/ieee')>();
  return { ...actual, readIeeePdf: async (input: { pageUrl: string; sourceUrl?: string }) => {
    throw Error('Reader must consume prepared bytes, not download IEEE again');
  } };
});
vi.mock("../../src/core/pdf-source", async (original) => {
  const actual = await original<typeof import("../../src/core/pdf-source")>();
  return {
    ...actual,
    readLocalPdf: async () => new Uint8Array([37, 80, 68, 70]),
    readRemotePdf: async (url: string) => {
      io.remoteReads.push(url);
      return new Uint8Array([37, 80, 68, 70]);
    },
    pdfHash: async () => io.hash,
  };
});
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  VerbosityLevel: { ERRORS: 0 },
  getDocument: (options: Record<string, unknown>) => {
    io.documentOptions.push(options);
    return {
      destroy: async () => undefined,
      promise: (io.parseGate ?? Promise.resolve()).then(() => ({
        numPages: io.pageCount,
        getData: async () => { io.dataReads++; return new Uint8Array([37, 80, 68, 70]); },
        getMetadata: async () => {
          if (io.metadataFailure) throw Error("metadata unavailable");
          return { info: { Title: io.metadataTitle }, metadata: {
            get: (name: string) => name === "dc:title" ? io.metadataTitle : name === "prism:doi" ? io.metadataDoi : null,
          } };
        },
        getPage: async (number: number) => {
          io.pagesRead.push(number);
          const width = 600;
          const height = number === 500 ? 480 : 800;
          return {
            rotate: 0,
            view: [0, 0, width, height],
            getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => ({
              width: (rotation % 180 ? height : width) * scale,
              height: (rotation % 180 ? width : height) * scale,
              scale,
              convertToPdfPoint: (x: number, y: number) => [x / scale, height - y / scale],
              convertToViewportPoint: (x: number, y: number) => [x * scale, (height - y) * scale],
              clone() { return { ...this }; },
            }),
            render: () => {
              io.renderedPages.push(number);
              // Model the strict stream error after the build-time PDF.js fix.
              const oversizedImage = number === 1 && io.rejectOversizedImage && options.stopAtErrors === true;
              const promise = io.renderGates[number] ?? (oversizedImage
                ? Promise.reject(new Error("Image exceeded maximum allowed size and was removed."))
                : Promise.resolve());
              return { promise, cancel: () => undefined };
            },
            streamTextContent: () => new ReadableStream({ start(controller) {
              controller.enqueue({ items: [{ str: "A selected scientific passage." }] });
              controller.close();
            } }),
            cleanup: () => undefined,
            getAnnotations: async () => { io.annotationsRead.push(number); return io.annotationGates[number] ?? io.nativeByPage[number] ?? []; },
          };
        },
      })),
    };
  },
  TextLayer: class {
    textDivs: HTMLElement[] = [];
    textContentItemsStr: string[] = [];
    constructor(private options: { container: HTMLElement }) {}
    async render() {
      const span = document.createElement("span");
      span.textContent = "A selected scientific passage.";
      this.options.container.append(span);
      this.textDivs = [span];
      this.textContentItemsStr = [span.textContent!];
    }
    cancel() {}
  },
  AnnotationType: { TEXT: 1, HIGHLIGHT: 9, SQUARE: 5 },
  AnnotationLayer: class { async render() {} destroy() {} },
}));

export { exportIo, io, noteRenderMetrics, pageRenderMetrics };
