import {
  COLORS,
  SCHEMA_VERSION,
  type Annotation,
  type BackupEnvelope,
  type ImageAnnotation,
  type ImageShape,
  type ImageTarget,
  type PdfAreaAnnotation,
  type PdfRect,
  type PdfTarget,
  type PdfTextAnnotation,
  type Point,
  type Settings,
  type TextAnnotation,
  type TextTarget,
} from "./model";
import { pageKey } from "./url";

export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
export const MAX_BACKUP_ANNOTATIONS = 50_000;
/** Revision zero is the unsaved client value; committed revisions start at one. */
export const MAX_REVISION = 1_000_000_000;

/** An expected client/input error. The request boundary maps this to INVALID_INPUT. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function invalid(message: string): never {
  throw new ValidationError(message);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(`${name} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  name: string,
  required: string[],
  optional: string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) invalid(`${name} has an unknown field: ${key}`);
  for (const key of required)
    if (!(key in value)) invalid(`${name}.${key} is required`);
}

function text(
  value: unknown,
  name: string,
  max: number,
  allowEmpty = true,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && value.length === 0) ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
  ) {
    invalid(`${name} must be plain text up to ${max} characters`);
  }
  return value;
}

function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    invalid(`${name} is out of range`);
  return value as number;
}

function finite(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    invalid(`${name} is out of range`);
  return value;
}

function timestamp(value: unknown, name: string): string {
  const result = text(value, name, 64, false);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result) ||
    Number.isNaN(Date.parse(result))
  ) {
    invalid(`${name} must be an ISO-8601 UTC timestamp`);
  }
  return result;
}

function color(value: unknown, name: string): string {
  const result = text(value, name, 7, false).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(result))
    invalid(`${name} must be a six-digit hex color`);
  return result;
}

function canonicalPageUrl(value: unknown, name: string): string {
  const raw = text(value, name, 8_192, false);
  try {
    const canonical = pageKey(raw);
    if (canonical !== raw) invalid(`${name} must be a canonical HTTP(S) URL`);
    return canonical;
  } catch {
    invalid(`${name} must be a canonical HTTP(S) URL`);
  }
}

function pdfPageUrl(value: unknown, hash: string): string {
  const pageUrl = text(value, "annotation.pageUrl", 128, false);
  if (pageUrl !== `urn:web-ink:pdf:${hash}`)
    invalid("annotation.pageUrl must match the PDF document hash");
  return pageUrl;
}

function identifier(value: unknown, name: string): string {
  const result = text(value, name, 128, false);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result))
    invalid(`${name} has an invalid format`);
  return result;
}

function httpSource(value: unknown, name: string): string {
  const source = text(value, name, 8_192, false);
  try {
    const url = new URL(source);
    if (!["http:", "https:"].includes(url.protocol))
      invalid(`${name} must be an HTTP(S) image URL`);
    return source;
  } catch {
    invalid(`${name} must be an HTTP(S) image URL`);
  }
}

function safeCurrentImageSource(
  value: unknown,
  pageUrl: string,
  name: string,
): string {
  const source = text(value, name, 8_192, false);
  if (source.startsWith("data:")) {
    if (
      !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/i.test(
        source,
      )
    )
      invalid(`${name} has an unsafe data image URL`);
    return source;
  }
  if (source.startsWith("blob:")) {
    try {
      const blobUrl = new URL(source);
      const page = new URL(pageUrl);
      if (blobUrl.origin !== page.origin)
        invalid(`${name} blob URL must belong to this page origin`);
      return source;
    } catch {
      invalid(`${name} has an invalid blob URL`);
    }
  }
  return httpSource(source, name);
}

function validateTextTarget(value: unknown): TextTarget {
  const target = object(value, "annotation.target");
  exactKeys(
    target,
    "annotation.target",
    ["exact", "prefix", "suffix", "start", "end", "rootSelector"],
    ["containerId"],
  );
  const exact = text(target.exact, "annotation.target.exact", 20_000, false);
  const start = integer(target.start, "annotation.target.start", 0, 10_000_000);
  const end = integer(target.end, "annotation.target.end", start, 10_000_000);
  if (end - start !== exact.length)
    invalid("annotation.target exact text and offsets disagree");
  const containerId =
    target.containerId === undefined
      ? undefined
      : text(target.containerId, "annotation.target.containerId", 512, false);
  return {
    exact,
    prefix: text(target.prefix, "annotation.target.prefix", 10_000),
    suffix: text(target.suffix, "annotation.target.suffix", 10_000),
    start,
    end,
    rootSelector: text(
      target.rootSelector,
      "annotation.target.rootSelector",
      2_048,
      false,
    ),
    ...(containerId === undefined ? {} : { containerId }),
  };
}

function validatePoint(value: unknown, index: number): Point {
  const point = object(value, `annotation.shape.points[${index}]`);
  exactKeys(
    point,
    `annotation.shape.points[${index}]`,
    ["x", "y"],
    ["pressure"],
  );
  const pressure =
    point.pressure === undefined
      ? undefined
      : finite(
          point.pressure,
          `annotation.shape.points[${index}].pressure`,
          0,
          1,
        );
  return {
    x: finite(point.x, `annotation.shape.points[${index}].x`, 0, 1),
    y: finite(point.y, `annotation.shape.points[${index}].y`, 0, 1),
    ...(pressure === undefined ? {} : { pressure }),
  };
}

function validateShape(value: unknown): ImageShape {
  const shape = object(value, "annotation.shape");
  exactKeys(shape, "annotation.shape", ["kind", "points", "width"]);
  if (
    shape.kind !== "rectangle" &&
    shape.kind !== "ellipse" &&
    shape.kind !== "arrow" &&
    shape.kind !== "pen"
  )
    invalid("annotation.shape.kind is unsupported");
  if (!Array.isArray(shape.points))
    invalid("annotation.shape.points must be an array");
  const limit = shape.kind === "pen" ? 2_000 : 2;
  const minimum = shape.kind === "pen" ? 1 : 2;
  if (shape.points.length < minimum || shape.points.length > limit)
    invalid("annotation.shape.points count is invalid for its shape kind");
  return {
    kind: shape.kind,
    points: shape.points.map((point, index) => validatePoint(point, index)),
    width: finite(shape.width, "annotation.shape.width", 0.0001, 1),
  };
}

function validateImageTarget(value: unknown, pageUrl: string): ImageTarget {
  const target = object(value, "annotation.target");
  exactKeys(target, "annotation.target", [
    "src",
    "sourceCandidates",
    "alt",
    "naturalWidth",
    "naturalHeight",
    "selector",
    "occurrence",
    "context",
  ]);
  if (
    !Array.isArray(target.sourceCandidates) ||
    target.sourceCandidates.length > 20
  )
    invalid(
      "annotation.target.sourceCandidates must contain at most 20 sources",
    );
  return {
    src: safeCurrentImageSource(target.src, pageUrl, "annotation.target.src"),
    sourceCandidates: target.sourceCandidates.map((source, index) =>
      safeCurrentImageSource(
        source,
        pageUrl,
        `annotation.target.sourceCandidates[${index}]`,
      ),
    ),
    alt: text(target.alt, "annotation.target.alt", 1_000),
    naturalWidth: integer(
      target.naturalWidth,
      "annotation.target.naturalWidth",
      1,
      100_000,
    ),
    naturalHeight: integer(
      target.naturalHeight,
      "annotation.target.naturalHeight",
      1,
      100_000,
    ),
    selector: text(target.selector, "annotation.target.selector", 2_048, false),
    occurrence: integer(
      target.occurrence,
      "annotation.target.occurrence",
      0,
      100_000,
    ),
    context: text(target.context, "annotation.target.context", 4_000),
  };
}

function validatePdfRect(value: unknown, index: number): PdfRect {
  const rect = object(value, `annotation.target.rects[${index}]`);
  exactKeys(rect, `annotation.target.rects[${index}]`, [
    "x",
    "y",
    "width",
    "height",
  ]);
  const x = finite(rect.x, `annotation.target.rects[${index}].x`, 0, 1);
  const y = finite(rect.y, `annotation.target.rects[${index}].y`, 0, 1);
  const width = finite(
    rect.width,
    `annotation.target.rects[${index}].width`,
    0.000001,
    1,
  );
  const height = finite(
    rect.height,
    `annotation.target.rects[${index}].height`,
    0.000001,
    1,
  );
  if (x + width > 1 || y + height > 1)
    invalid(`annotation.target.rects[${index}] exceeds the PDF page viewBox`);
  return { x, y, width, height };
}

function validatePdfTarget(
  value: unknown,
  kind: "pdf-text" | "pdf-area",
): PdfTarget {
  const target = object(value, "annotation.target");
  exactKeys(
    target,
    "annotation.target",
    [
      "documentHash",
      "fileName",
      "pageNumber",
      "rects",
      "exact",
      "prefix",
      "suffix",
    ],
    ["sourceUrl"],
  );
  const documentHash = text(
    target.documentHash,
    "annotation.target.documentHash",
    64,
    false,
  ).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(documentHash))
    invalid("annotation.target.documentHash must be a SHA-256 hex digest");
  if (
    !Array.isArray(target.rects) ||
    target.rects.length < 1 ||
    target.rects.length > 500
  )
    invalid("annotation.target.rects must contain 1 to 500 rectangles");
  const sourceUrl =
    target.sourceUrl === undefined
      ? undefined
      : httpSource(target.sourceUrl, "annotation.target.sourceUrl");
  if (sourceUrl !== undefined && !sourceUrl.startsWith("https:"))
    invalid("annotation.target.sourceUrl must use HTTPS");
  return {
    documentHash,
    fileName: text(target.fileName, "annotation.target.fileName", 512, false),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    pageNumber: integer(
      target.pageNumber,
      "annotation.target.pageNumber",
      1,
      100_000,
    ),
    rects: target.rects.map(validatePdfRect),
    exact: text(
      target.exact,
      "annotation.target.exact",
      20_000,
      kind === "pdf-area",
    ),
    prefix: text(target.prefix, "annotation.target.prefix", 10_000),
    suffix: text(target.suffix, "annotation.target.suffix", 10_000),
  };
}

export function validateAnnotation(value: unknown): Annotation {
  const annotation = object(value, "annotation");
  exactKeys(
    annotation,
    "annotation",
    [
      "id",
      "pageUrl",
      "pageTitle",
      "color",
      "note",
      "tags",
      "createdAt",
      "updatedAt",
      "revision",
      "kind",
      "target",
    ],
    ["shape"],
  );
  if (!Array.isArray(annotation.tags) || annotation.tags.length > 50)
    invalid("annotation.tags must contain at most 50 tags");
  const tags = annotation.tags.map((tag, index) =>
    text(tag, `annotation.tags[${index}]`, 64, false),
  );
  if (new Set(tags).size !== tags.length)
    invalid("annotation.tags must not contain duplicates");
  const base = {
    id: identifier(annotation.id, "annotation.id"),
    pageTitle: text(annotation.pageTitle, "annotation.pageTitle", 500),
    color: color(annotation.color, "annotation.color"),
    note: text(annotation.note, "annotation.note", 10_000),
    tags,
    createdAt: timestamp(annotation.createdAt, "annotation.createdAt"),
    updatedAt: timestamp(annotation.updatedAt, "annotation.updatedAt"),
    revision: integer(
      annotation.revision,
      "annotation.revision",
      0,
      MAX_REVISION,
    ),
  };
  if (Date.parse(base.updatedAt) < Date.parse(base.createdAt))
    invalid("annotation.updatedAt precedes createdAt");
  if (annotation.kind === "text") {
    const pageUrl = canonicalPageUrl(annotation.pageUrl, "annotation.pageUrl");
    if ("shape" in annotation) invalid("text annotations cannot include shape");
    const result: TextAnnotation = {
      ...base,
      pageUrl,
      kind: "text",
      target: validateTextTarget(annotation.target),
    };
    return result;
  }
  if (annotation.kind === "image") {
    const pageUrl = canonicalPageUrl(annotation.pageUrl, "annotation.pageUrl");
    if (!("shape" in annotation)) invalid("image annotations require shape");
    const result: ImageAnnotation = {
      ...base,
      pageUrl,
      kind: "image",
      target: validateImageTarget(annotation.target, pageUrl),
      shape: validateShape(annotation.shape),
    };
    return result;
  }
  if (annotation.kind === "pdf-text" || annotation.kind === "pdf-area") {
    if ("shape" in annotation) invalid("PDF annotations cannot include shape");
    const target = validatePdfTarget(annotation.target, annotation.kind);
    const pageUrl = pdfPageUrl(annotation.pageUrl, target.documentHash);
    if (annotation.kind === "pdf-text") {
      const result: PdfTextAnnotation = {
        ...base,
        pageUrl,
        kind: "pdf-text",
        target,
      };
      return result;
    }
    const result: PdfAreaAnnotation = {
      ...base,
      pageUrl,
      kind: "pdf-area",
      target,
    };
    return result;
  }
  invalid("annotation.kind is unsupported");
}

export function validateSettings(value: unknown): Settings {
  const settings = object(value, "settings");
  exactKeys(
    settings,
    "settings",
    ["language", "defaultColor", "disabledOrigins"],
    ["theme", "reduceMotion", "reduceTransparency"],
  );
  if (settings.language !== "zh-CN" && settings.language !== "en")
    invalid("settings.language is unsupported");
  if (
    !Array.isArray(settings.disabledOrigins) ||
    settings.disabledOrigins.length > 200
  )
    invalid("settings.disabledOrigins must contain at most 200 origins");
  const disabledOrigins = settings.disabledOrigins.map((origin, index) => {
    const raw = text(
      origin,
      `settings.disabledOrigins[${index}]`,
      2_048,
      false,
    );
    try {
      const url = new URL(raw);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== raw)
        invalid(`settings.disabledOrigins[${index}] must be an HTTP(S) origin`);
      return raw;
    } catch {
      invalid(`settings.disabledOrigins[${index}] must be an HTTP(S) origin`);
    }
  });
  if (new Set(disabledOrigins).size !== disabledOrigins.length)
    invalid("settings.disabledOrigins must not contain duplicates");
  const theme = settings.theme === undefined ? "system" : settings.theme;
  if (theme !== "system" && theme !== "light" && theme !== "dark")
    invalid("settings.theme is unsupported");
  const reduceMotion =
    settings.reduceMotion === undefined ? false : settings.reduceMotion;
  const reduceTransparency =
    settings.reduceTransparency === undefined
      ? false
      : settings.reduceTransparency;
  if (
    typeof reduceMotion !== "boolean" ||
    typeof reduceTransparency !== "boolean"
  )
    invalid("settings accessibility fields must be booleans");
  return {
    language: settings.language,
    defaultColor: color(settings.defaultColor, "settings.defaultColor"),
    disabledOrigins,
    theme,
    reduceMotion,
    reduceTransparency,
  };
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    invalid("backup must be JSON-serializable");
  }
}

/** Parses a JSON-shaped backup before any database transaction starts. */
export function validateBackup(value: unknown): BackupEnvelope {
  if (jsonBytes(value) > MAX_BACKUP_BYTES)
    invalid(`backup exceeds ${MAX_BACKUP_BYTES} bytes`);
  const backup = object(value, "backup");
  exactKeys(
    backup,
    "backup",
    ["format", "schemaVersion", "exportedAt", "annotations"],
    ["settings"],
  );
  if (backup.format !== "web-ink") invalid("backup.format is unsupported");
  if (backup.schemaVersion !== 1 && backup.schemaVersion !== SCHEMA_VERSION)
    invalid("backup.schemaVersion is unsupported");
  const exportedAt = timestamp(backup.exportedAt, "backup.exportedAt");
  if (
    !Array.isArray(backup.annotations) ||
    backup.annotations.length > MAX_BACKUP_ANNOTATIONS
  )
    invalid(
      `backup.annotations must contain at most ${MAX_BACKUP_ANNOTATIONS} records`,
    );
  const annotations = backup.annotations.map(validateAnnotation);
  const ids = new Set(annotations.map((annotation) => annotation.id));
  if (ids.size !== annotations.length)
    invalid("backup.annotations contains duplicate IDs");
  const settings =
    backup.settings === undefined
      ? undefined
      : validateSettings(backup.settings);
  if (
    backup.schemaVersion === 1 &&
    annotations.some(
      (annotation) =>
        annotation.kind === "pdf-text" || annotation.kind === "pdf-area",
    )
  ) {
    invalid("schema v1 backup cannot contain PDF annotations");
  }
  return {
    format: "web-ink",
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    annotations,
    ...(settings === undefined ? {} : { settings }),
  };
}

/** Useful for generated UI defaults and tests; validates the source-of-truth literal too. */
export function validatedDefaultSettings(): Settings {
  return validateSettings({
    language: "zh-CN",
    defaultColor: COLORS[0],
    disabledOrigins: [],
  });
}
