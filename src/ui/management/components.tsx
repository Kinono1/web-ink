/**
 * Barrel for management view components. Screens keep importing from this
 * path; each surface lives in its own module under `components/`.
 */
export { Alert, Empty, PageHeader, SelectionToolbarSwitch } from "./components/common";
export { FilterPopover } from "./components/filters";
export { AnnotationBrowser } from "./components/browser";
export { SettingsView } from "./components/settings";
