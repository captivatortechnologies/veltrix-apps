// =============================================================================
// Shared app code lives in lib/ — the canonical home for anything used by
// more than one handler (API clients, field parsers, constants).
//
// Handlers import it with a relative path, e.g. in handlers/configs/deploy.ts:
//   import { createToolClient } from ../../lib/client  (add quotes)
//
// Rules: only relative imports within the app + published packages —
// the validator rejects imports that escape the app directory.
// =============================================================================

export interface ToolClientOptions {
  /** Management API base URL, e.g. from ctx.canvas fields or app settings. */
  baseUrl: string
  /** API token, e.g. from ctx.credential.apiToken. */
  token: string | null
  timeoutMs?: number
}

/**
 * Example shared API client for your tool. Replace with real calls —
 * every handler (deploy, healthCheck, driftDetect, ...) should reuse this
 * instead of duplicating fetch logic.
 */
export function createToolClient(options: ToolClientOptions) {
  const { baseUrl, token, timeoutMs = 30_000 } = options

  async function request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(apiPath, baseUrl), {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) {
      throw new Error(`${method} ${apiPath} failed: HTTP ${response.status}`)
    }
    return (await response.json()) as T
  }

  return {
    get: <T>(apiPath: string) => request<T>('GET', apiPath),
    post: <T>(apiPath: string, body: unknown) => request<T>('POST', apiPath, body),
    delete: <T>(apiPath: string) => request<T>('DELETE', apiPath),
  }
}
