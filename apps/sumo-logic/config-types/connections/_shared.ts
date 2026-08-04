// Shared helpers for the Sumo Logic Connections config type
// (deploy + rollback + drift + validate).
//
// A connection is a notification destination Monitors (and scheduled-search
// notifications) can send to. The Management API only accepts full CRUD for
// TWO connection kinds — confirmed against the official OpenAPI spec's
// `ConnectionDefinition` discriminator and the DELETE endpoint's type pattern
// (`^(WebhookConnection|ServiceNowConnection)$`):
//   - Webhook  — a generic mechanism that also implements Slack, PagerDuty,
//     Datadog, Jira, Opsgenie, MicrosoftTeams, NewRelic, AWSLambda, Azure,
//     HipChat and SumoCloudSOAR by setting `webhookType` on a webhook body.
//   - ServiceNow — its own dedicated username/password-based connection kind.
// Every other kind in the Sumo Logic UI is either read-only via this API or
// unsupported for write (see the app README Coverage section).
//
// Sumo Logic uses two different type-string vocabularies for the same kind:
// `WebhookDefinition`/`ServiceNowDefinition` on write (POST/PUT body), and
// `WebhookConnection`/`ServiceNowConnection` on the read model and the DELETE
// endpoint's required `type` query parameter.
//   API: https://www.sumologic.com/help/docs/api/connection-management/
//   Verified against the official Sumo Logic OpenAPI spec
//   (ConnectionDefinition / WebhookDefinition / ServiceNowDefinition,
//   api.sumologic.com/docs/sumologic-api.yaml).

/** One Sumo Logic connection (read model — `type` is the *Connection suffix). */
export interface Connection {
  id?: string
  name: string
  description?: string
  /** WebhookConnection or ServiceNowConnection (the *Connection suffix used on read/delete). */
  type: string
  url?: string
  username?: string
  webhookType?: string
  connectionSubtype?: string
  defaultPayload?: string
  resolutionPayload?: string
  headers?: Array<{ name: string; value: string }>
  customHeaders?: Array<{ name: string; value: string }>
  [key: string]: unknown
}

/** The { data: [...], next } envelope returned by GET /connections. */
export interface ConnectionList {
  data?: Connection[]
  next?: string | null
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/** Map the canvas-declared write type (…Definition) to the read/delete type (…Connection). */
export function definitionTypeToConnectionType(defType: string): string {
  return defType.replace(/Definition$/, 'Connection')
}

/** Unwrap the { data: [...] } list envelope into a flat array of connections. */
export function connectionsFromList(list: unknown): Connection[] {
  if (Array.isArray(list)) return list as Connection[]
  const data = (list as ConnectionList | null | undefined)?.data
  return Array.isArray(data) ? data : []
}

/** Find a live connection by name (case-insensitive, trimmed) — the identity. */
export function findConnection(connections: Connection[], name: string): Connection | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return connections.find((c) => s(c.name).toLowerCase() === n) ?? null
}

/**
 * Coerce a canvas `keyvalue` field (a `{ [name]: value }` map) — or an already
 * Sumo-shaped `[{ name, value }]` array — into the `[{ name, value }]` list the
 * Header schema expects.
 */
export function toHeaderList(value: unknown): Array<{ name: string; value: string }> {
  if (Array.isArray(value)) {
    return value
      .map((v) => ({ name: s((v as { name?: unknown })?.name), value: s((v as { value?: unknown })?.value) }))
      .filter((h) => h.name)
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([name, v]) => ({ name: s(name), value: s(v) }))
      .filter((h) => h.name)
  }
  return []
}

/** Build the create/update request body (a `*Definition`) from canvas fields. */
export function buildConnectionBody(fields: Record<string, unknown>): Record<string, unknown> {
  const type = s(fields.type) || 'WebhookDefinition'
  const body: Record<string, unknown> = { type, name: s(fields.name), description: s(fields.description) }

  if (type === 'ServiceNowDefinition') {
    body.url = s(fields.url)
    body.username = s(fields.username)
    if (s(fields.password)) body.password = s(fields.password)
    return body
  }

  body.url = s(fields.url)
  body.webhookType = s(fields.webhookType) || 'Webhook'
  body.defaultPayload = s(fields.defaultPayload)
  const resolutionPayload = s(fields.resolutionPayload)
  if (resolutionPayload) body.resolutionPayload = resolutionPayload
  const headers = toHeaderList(fields.headers)
  if (headers.length) body.headers = headers
  const customHeaders = toHeaderList(fields.customHeaders)
  if (customHeaders.length) body.customHeaders = customHeaders
  return body
}

/**
 * Restore-request body for rollback, rebuilt from a prior connection snapshot
 * (a live GET result). SECRET LIMITATION: `headers` (which typically carry the
 * Authorization value) and a ServiceNow `password` are write-only and Sumo
 * Logic masks/omits them on read — see the official docs' note on
 * `POST /connections/test` needing a `connectionId` "if the request body of an
 * existing connection contains masked authorization headers". A connection
 * whose secret headers or password changed keeps whatever the deploy set; the
 * previous values cannot be recovered and must be re-entered if needed.
 */
export function buildConnectionRestoreBody(prior: Connection): Record<string, unknown> {
  const type = definitionType(prior.type)
  const body: Record<string, unknown> = { type, name: s(prior.name), description: s(prior.description) }
  if (type === 'ServiceNowDefinition') {
    body.url = s(prior.url)
    body.username = s(prior.username)
    return body
  }
  body.url = s(prior.url)
  body.webhookType = s(prior.webhookType) || 'Webhook'
  body.defaultPayload = s(prior.defaultPayload)
  if (s(prior.resolutionPayload)) body.resolutionPayload = s(prior.resolutionPayload)
  const customHeaders = toHeaderList(prior.customHeaders)
  if (customHeaders.length) body.customHeaders = customHeaders
  return body
}

/** Map a read-model type (…Connection) back to its write-model type (…Definition). */
function definitionType(connType: string | undefined): string {
  const t = s(connType)
  return t === 'ServiceNowConnection' ? 'ServiceNowDefinition' : 'WebhookDefinition'
}
