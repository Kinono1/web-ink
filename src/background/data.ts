/**
 * Storage-authority facade. Implementation lives in `./data/*` by responsibility;
 * this path is the frozen public contract (`handleDataRequest`, `KnownMessage`).
 */
export { handleDataRequest } from "./data/handler";
export type { DataRequestContext, KnownMessage } from "./data/validation";
