// Shared helpers for the SonarQube Webhooks config type (validate + deploy + rollback +
// drift). Pure and network-free so validate.ts and the tests can use it.
//
// A webhook is authored as a name (identity), a delivery URL, an optional HMAC secret and
// an optional scope: blank project = a GLOBAL webhook, a project key = a project webhook.
// Applied over the SonarQube Web API (/api/webhooks). SonarQube addresses a webhook by an
// opaque `key`, but keys are not stable identifiers a human authors, so we upsert by NAME
// within a scope (resolving the key from /api/webhooks/list at deploy time).
//
// NOTE (verified): /api/webhooks/list and /create never return the secret — only a
// `hasSecret` boolean — so a secret value can be neither drift-compared nor restored on
// rollback. Names are also not required to be unique; we treat the first match in a scope
// as the target.

/** A webhook as returned by /api/webhooks/list or /create ({ key, name, url, hasSecret }). */
export interface SonarWebhook {
  key?: string
  name?: string
  url?: string
  hasSecret?: boolean
  [key: string]: unknown
}

/** Unwrap SonarQube's `{ webhooks: [...] }` list envelope into a flat array. */
export function webhooksFromList(payload: unknown): SonarWebhook[] {
  if (payload && typeof payload === 'object' && Array.isArray((payload as { webhooks?: unknown }).webhooks)) {
    return (payload as { webhooks: SonarWebhook[] }).webhooks
  }
  return []
}

/** Find a live webhook by exact name (first match — SonarQube names need not be unique). */
export function findWebhook(webhooks: SonarWebhook[], name: string): SonarWebhook | null {
  const n = name.trim()
  return webhooks.find((w) => String(w.name ?? '').trim() === n) ?? null
}

/** Normalize the optional project scope to a trimmed key, or '' for a global webhook. */
export function scopeOf(value: unknown): string {
  return String(value ?? '').trim()
}

/** A URL is acceptable if it parses and is http(s) — SonarQube only calls http/https. */
export function isValidWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
