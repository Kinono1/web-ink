import type { Annotation } from "../../core/model";
export type Mode = "sidepanel" | "library";
export type Screen = "library" | "settings";
export type TabContext = { id?: number; url?: string; title?: string };
export type Draft = { note: string; tags: string; color: string; base: Annotation };
export type AnnotationKind = Annotation["kind"];
export type FilterKind = "all" | AnnotationKind;
export type NoticeMessage = {
  type?: string;
  tabId?: number;
  pageUrl?: string;
  annotation?: Annotation;
  deletedId?: string;
};

