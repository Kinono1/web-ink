import type { Request, Result } from './model';
export class RequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = 'RequestError'; }
}
/** One request/response boundary. A resolved response means the transaction has committed. */
export async function request<T>(message: Request): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as Result<T> | undefined;
  if (!response) throw new Error('Extension unavailable. Reload this page. / 扩展不可用，请刷新网页。');
  if (!response.ok) throw new RequestError(response.error, response.code);
  return response.data;
}
