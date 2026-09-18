/** Durable, versioned records. DOM nodes and viewport coordinates never enter storage. */
export const SCHEMA_VERSION = 2 as const;
export const COLORS = ['#facc15', '#4ade80', '#38bdf8', '#c084fc', '#fb7185', '#fb923c'] as const;
export type Language = 'zh-CN' | 'en';
export interface Settings {
  language: Language;
  defaultColor: string;
  disabledOrigins: string[];
  /** Optional for compatibility with v1 settings stored in chrome.storage.local. */
  theme?: 'system' | 'light' | 'dark';
  reduceMotion?: boolean;
  reduceTransparency?: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  language: 'zh-CN', defaultColor: COLORS[0], disabledOrigins: [],
  theme: 'system', reduceMotion: false, reduceTransparency: false,
};
export interface TextTarget {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  /** Reading root selector; always verified against text when resolving. */
  rootSelector: string;
  /** Stable element ID, when present, to guard against moving to another paragraph. */
  containerId?: string;
}
export interface ImageTarget {
  src: string;
  sourceCandidates: string[];
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
  selector: string;
  occurrence: number;
  /** Nearby caption/paragraph is a disambiguation hint, never an ordinal-only fallback. */
  context: string;
}
export interface Point { x: number; y: number; pressure?: number }
export type ShapeKind = 'rectangle' | 'ellipse' | 'arrow' | 'pen';
export interface ImageShape {
  kind: ShapeKind;
  /** Coordinates relative to intrinsic image content, constrained to [0,1]. */
  points: Point[];
  /** Fraction of intrinsic image width, not screen pixels. */
  width: number;
}
export interface AnnotationBase {
  id: string;
  pageUrl: string;
  pageTitle: string;
  color: string;
  note: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface TextAnnotation extends AnnotationBase { kind: 'text'; target: TextTarget }
export interface ImageAnnotation extends AnnotationBase { kind: 'image'; target: ImageTarget; shape: ImageShape }
/** Coordinates in the unrotated PDF page viewBox, normalized to [0,1]. */
export interface PdfRect { x: number; y: number; width: number; height: number }
export interface PdfTarget {
  /** SHA-256 hex of the exact PDF bytes; URL equality alone never identifies a document. */
  documentHash: string;
  fileName: string;
  sourceUrl?: string;
  pageNumber: number;
  rects: PdfRect[];
  exact: string;
  prefix: string;
  suffix: string;
}
export interface PdfTextAnnotation extends AnnotationBase { kind: 'pdf-text'; target: PdfTarget }
export interface PdfAreaAnnotation extends AnnotationBase { kind: 'pdf-area'; target: PdfTarget }
export type Annotation = TextAnnotation | ImageAnnotation | PdfTextAnnotation | PdfAreaAnnotation;
export interface PageRecord { url: string; title: string; updatedAt: string; enabled?: boolean }
export interface PageMode { enabled: boolean }
export interface BackupEnvelope {
  format: 'web-ink';
  schemaVersion: typeof SCHEMA_VERSION;
  exportedAt: string;
  annotations: Annotation[];
  settings?: Settings;
}
/** Read-only compatibility shape accepted at import; exports are always schema v2. */
export interface BackupEnvelopeV1 {
  format: 'web-ink';
  schemaVersion: 1;
  exportedAt: string;
  annotations: Array<TextAnnotation | ImageAnnotation>;
  settings?: Settings;
}
export type AnchorStatus = 'located' | 'pending' | 'unresolved' | 'unsupported';
export interface AnchorState { id: string; status: AnchorStatus; reason?: string }
export interface ImportPreview { added: number; identical: number; conflicts: number; total: number }
export interface AnnotationCursor { updatedAt: string; id: string }
export interface AnnotationQuery {
  pageUrl?: string;
  kind?: Annotation['kind'];
  color?: string;
  tag?: string;
  text?: string;
  cursor?: AnnotationCursor;
  /** Clamped by the service worker to 1..50. */
  limit?: number;
  /** UI-generated token. Use annotations.query.cancel to stop an obsolete scan. */
  requestId?: string;
}
export interface AnnotationPage { items: Annotation[]; nextCursor?: AnnotationCursor; cancelled?: boolean }
export interface StorageStats {
  annotationCount: number;
  textCount: number;
  imageCount: number;
  pdfTextCount?: number;
  pdfAreaCount?: number;
  pageCount: number;
  /** UTF-8 JSON size of records, metadata and settings, not physical disk usage. */
  logicalBytes: number;
  backupBytes: number;
  browserUsageBytes: number | null;
  browserQuotaBytes: number | null;
  backupLimitBytes: number;
  backupRecordLimit: number;
  storageWarningBytes: number;
}
export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };
export type Request =
  | { type: 'annotations.list'; pageUrl?: string }
  | { type: 'annotations.put'; annotation: Annotation; expectedRevision: number }
  /** Restore a just-deleted identity through its tombstone; never use put(expectedRevision: 0). */
  | { type: 'annotations.restore'; annotation: Annotation }
  | { type: 'annotations.delete'; id: string; expectedRevision: number }
  | { type: 'annotations.query'; query: AnnotationQuery }
  | { type: 'annotations.query.cancel'; requestId: string }
  | { type: 'engine.ensure'; pageUrl: string }
  | { type: 'settings.get' }
  | { type: 'settings.put'; settings: Settings }
  | { type: 'page.mode.get'; pageUrl: string }
  | { type: 'page.mode.put'; pageUrl: string; enabled: boolean }
  | { type: 'storage.stats'; recalculate?: boolean }
  | { type: 'backup.export' }
  | { type: 'backup.preview'; backup: unknown }
  | { type: 'backup.import'; backup: unknown; overwrite: boolean }
  | { type: 'page.states'; states: AnchorState[]; pageUrl: string }
  | { type: 'page.state.get'; tabId: number }
  | { type: 'page.action'; tabId: number; action: 'focus' | 'rebind' | 'draw' | 'refresh'; id?: string }
  | { type: 'permissions.enable' };
export type Notification =
  | { type: 'annotations.changed'; pageUrl?: string; annotation?: Annotation; deletedId?: string }
  | { type: 'settings.changed' }
  | { type: 'page.mode.changed'; pageUrl: string }
  | { type: 'page.action.execute'; action: 'focus' | 'rebind' | 'draw' | 'refresh'; id?: string };
