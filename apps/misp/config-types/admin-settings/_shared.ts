// Shared helpers for the MISP Admin Settings config type (deploy + rollback + drift).
//
// MISP server-setting shapes follow the 2.4 REST API (/servers/getSetting/{name},
// /servers/serverSettingsEdit/{name}); verify against a live MISP 2.4 instance.
//
// This is MISP's single generic key/value configuration store — every dotted
// setting name (MISP.*, Security.*, Proxy.*, GnuPG.*, Plugin.*, ...) is read and
// written through the SAME two endpoints, keyed by name. There is no separate
// "server-sync config" REST surface: sync-shaping settings such as
// MISP.host_org_id, MISP.baseurl and MISP.manager are just more rows in this
// same store — see the README for the full rationale. `redacted` settings
// (secret material such as Security.salt or SMTP credentials) throw a 403 on
// read and are never written by this type.

/** Valid yes/no select values from the canvas. */
export const YES_NO = new Set(['yes', 'no'])

/** A setting as returned by GET /servers/getSetting/{name} (flat, no envelope). */
export interface MispServerSetting {
  name?: string
  value?: unknown
  redacted?: boolean
  cli_only?: boolean
  type?: string
  error?: number
  errorMessage?: string | null
}

/** The response shape from POST /servers/serverSettingsEdit/{name}. */
export interface ServerSettingsEditResponse {
  saved?: boolean
  success?: string
  message?: string
  errors?: unknown
  name?: string
  url?: string
}

/** Normalize a yes/no select (or a boolean / 1|0) to a boolean. */
export function normalizeYesNo(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1'
}

/**
 * Throw a descriptive error when a serverSettingsEdit response reports failure.
 * MISP's RestResponse can report a save failure with a 200 status and a
 * `{ saved: false, errors: ... }` (or CakePHP-style `{ errors: [...] }`) body
 * rather than a non-2xx HTTP status, so this must be checked explicitly in
 * addition to sendJson's own HTTP-status check.
 */
export function assertSettingSaved(name: string, response: ServerSettingsEditResponse): void {
  if (response?.saved === false) {
    const detail = typeof response.errors === 'string' ? response.errors : JSON.stringify(response.errors ?? response.message ?? 'unknown error')
    throw new Error(`MISP rejected setting "${name}": ${detail}`)
  }
}
