/** Durable, versioned records. DOM nodes and viewport coordinates never enter storage. */
export const SCHEMA_VERSION = 1 as const;
export const COLORS = ['#facc15', '#4ade80', '#38bdf8', '#c084fc', '#fb7185', '#fb923c'] as const;
export type Language = 'zh-CN' | 'en';
export interface Settings {
  language: Language;
  defaultColor: string;
  disabledOrigins: string[];
}
export const DEFAULT_SETTINGS: Settings = { language: 'zh-CN', defaultColor: COLORS[0], disabledOrigins: [] };
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
export type Annotation = TextAnnotation | ImageAnnotation;
export interface PageRecord { url: string; title: string; updatedAt: string; enabled?: boolean }
export interface PageMode { enabled: boolean }
export interface BackupEnvelope {
  format: 'web-ink';
  schemaVersion: typeof SCHEMA_VERSION;
  exportedAt: string;
  annotations: Annotation[];
  settings?: Settings;
}
export type AnchorStatus = 'located' | 'pending' | 'unresolved' | 'unsupported';
export interface AnchorState { id: string; status: AnchorStatus; reason?: string }
export interface ImportPreview { added: number; identical: number; conflicts: number; total: number }
export interface StorageStats {
  annotationCount: number;
  textCount: number;
  imageCount: number;
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
  | { type: 'annotations.delete'; id: string; expectedRevision: number }
  | { type: 'settings.get' }
  | { type: 'settings.put'; settings: Settings }
  | { type: 'page.mode.get'; pageUrl: string }
  | { type: 'page.mode.put'; pageUrl: string; enabled: boolean }
  | { type: 'storage.stats' }
  | { type: 'backup.export' }
  | { type: 'backup.preview'; backup: unknown }
  | { type: 'backup.import'; backup: unknown; overwrite: boolean }
  | { type: 'page.states'; states: AnchorState[]; pageUrl: string }
  | { type: 'page.state.get'; tabId: number }
  | { type: 'page.action'; tabId: number; action: 'focus' | 'rebind' | 'draw' | 'refresh'; id?: string }
  | { type: 'permissions.enable' };
export type Notification =
  | { type: 'annotations.changed'; pageUrl?: string }
  | { type: 'settings.changed' }
  | { type: 'page.mode.changed'; pageUrl: string }
  | { type: 'page.action.execute'; action: 'focus' | 'rebind' | 'draw' | 'refresh'; id?: string };
