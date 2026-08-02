// Shared helpers for the Auth0 Applications (Clients) config type
// (deploy + rollback + drift). Client shapes follow the Auth0 Management API v2
// Clients endpoints (GET/POST /clients, GET/PATCH/DELETE /clients/{client_id}).

/** Auth0 application types this config type authors. */
export const APP_TYPES = new Set(['spa', 'native', 'regular_web', 'non_interactive'])

/**
 * Token endpoint auth methods. The empty string means "leave to Auth0's default"
 * (public clients default to `none`, confidential clients to a client_secret_*
 * method) and is omitted from the request body.
 */
export const TOKEN_AUTH_METHODS = new Set(['', 'none', 'client_secret_post', 'client_secret_basic'])

/** One Auth0 client as returned by the Management API. */
export interface Auth0Client {
  client_id?: string
  name?: string
  app_type?: string
  callbacks?: string[]
  allowed_logout_urls?: string[]
  web_origins?: string[]
  grant_types?: string[]
  token_endpoint_auth_method?: string
  [key: string]: unknown
}

/**
 * The subset of client fields this config type manages, as sent to POST/PATCH.
 * `token_endpoint_auth_method` is only included when the operator set one.
 */
export interface Auth0ClientBody {
  name: string
  app_type?: string
  callbacks: string[]
  allowed_logout_urls: string[]
  web_origins: string[]
  token_endpoint_auth_method?: string
}

/**
 * Normalize a list field into a clean array of entries. Accepts either an array
 * (tags-style field) or a newline/comma-separated string (textarea) — trims,
 * drops blanks, and de-duplicates while preserving order.
 */
export function parseList(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => String(v ?? ''))
    : String(value ?? '').split(/[\n,]+/)
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

/** Find a live client by name (case-sensitive, trimmed) — the upsert identity. */
export function findClientByName(clients: Auth0Client[], name: string): Auth0Client | null {
  const n = name.trim()
  if (!n) return null
  return clients.find((c) => String(c.name ?? '').trim() === n) ?? null
}

/** Build the managed client body from canvas fields. */
export function buildClientBody(fields: Record<string, unknown>): Auth0ClientBody {
  const appType = String(fields.app_type ?? '').trim()
  const tokenAuth = String(fields.token_endpoint_auth_method ?? '').trim()
  const body: Auth0ClientBody = {
    name: String(fields.name ?? '').trim(),
    callbacks: parseList(fields.callbacks),
    allowed_logout_urls: parseList(fields.allowed_logout_urls),
    web_origins: parseList(fields.web_origins),
  }
  if (appType) body.app_type = appType
  if (tokenAuth) body.token_endpoint_auth_method = tokenAuth
  return body
}

/**
 * The prior managed state of a client, captured for rollback. `null` when the
 * client did not exist before this deploy (so rollback deletes it).
 */
export function snapshotManagedFields(client: Auth0Client): Auth0ClientBody {
  return {
    name: String(client.name ?? '').trim(),
    app_type: client.app_type,
    callbacks: Array.isArray(client.callbacks) ? client.callbacks : [],
    allowed_logout_urls: Array.isArray(client.allowed_logout_urls) ? client.allowed_logout_urls : [],
    web_origins: Array.isArray(client.web_origins) ? client.web_origins : [],
    token_endpoint_auth_method: client.token_endpoint_auth_method,
  }
}

/** Two URL lists are equal if they contain the same entries (order-insensitive). */
export function sameUrlList(a: unknown, b: unknown): boolean {
  const sa = parseList(a).slice().sort()
  const sb = parseList(b).slice().sort()
  if (sa.length !== sb.length) return false
  return sa.every((v, i) => v === sb[i])
}
