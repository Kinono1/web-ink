import type { Result } from "../core/model";
import { ValidationError } from "../core/validation";
import { PageContextError } from "./content-page";

export const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
export const fail = (error: string, code?: string): Result<never> =>
  ({ ok: false, error, ...(code === undefined ? {} : { code }) });
export const invalid = (error: string): Result<never> => fail(error, "INVALID_INPUT");

function logInternalFailure(operation: string): void {
  // Operation names are call-site constants. URLs, requests and raw errors can contain private data.
  console.warn("[Web Ink background]", operation, "INTERNAL");
}

export function requestFailure(error: unknown, operation: string, message: string): Result<never> {
  if (error instanceof ValidationError) return invalid(error.message);
  if (error instanceof PageContextError) return fail(error.message, error.code);
  logInternalFailure(operation);
  return fail(message, "INTERNAL");
}

export function observeBackgroundTask(task: Promise<unknown>, operation: string): void {
  void task.catch(() => logInternalFailure(operation));
}
