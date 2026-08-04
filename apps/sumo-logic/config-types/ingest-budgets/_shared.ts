// Shared helpers for the Sumo Logic Ingest Budgets config type
// (deploy + rollback + drift + validate).
//
// An ingest budget caps daily ingest volume for messages matching a field
// scope (e.g. _sourceCategory=*prod*nginx*) and takes an action once the
// capacity is reached. Lives under the v2 API (`/api/v2/ingestBudgets`) — a
// distinct base URL from the v1 config types in this app. The list endpoint
// returns a { data: [...], next } envelope and pages via a `?token=` query
// parameter, same shape as the v1 paged endpoints.
//   API: https://help.sumologic.com/docs/api/ingest-budget-v2/
//   Fields verified against the official Sumo Logic OpenAPI spec
//   (IngestBudgetDefinitionV2, api.sumologic.com/docs/sumologic-api.yaml).

/** One Sumo Logic ingest budget. */
export interface IngestBudget {
  id?: string
  /** Display name of the budget — the stable identity used to upsert. */
  name: string
  /** Field-based scope the budget applies to, e.g. _sourceCategory=*prod*nginx*. */
  scope: string
  /** Capacity in bytes/day before the configured action fires. */
  capacityBytes: number
  /** stopCollecting or keepCollecting once capacity is reached. */
  action: string
  timezone?: string
  /** Reset time in HH:MM format. */
  resetTime?: string
  description?: string
  /** Percentage (1-99) at which usage is logged to the Audit Index. */
  auditThreshold?: number
  usageBytes?: number
  usageStatus?: string
  [key: string]: unknown
}

/** The { data: [...], next } envelope returned by GET /ingestBudgets. */
export interface IngestBudgetList {
  data?: IngestBudget[]
  next?: string | null
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/** Unwrap the { data: [...] } list envelope into a flat array of budgets. */
export function ingestBudgetsFromList(list: unknown): IngestBudget[] {
  if (Array.isArray(list)) return list as IngestBudget[]
  const data = (list as IngestBudgetList | null | undefined)?.data
  return Array.isArray(data) ? data : []
}

/** Find a live ingest budget by name (case-insensitive, trimmed) — the identity. */
export function findIngestBudget(budgets: IngestBudget[], name: string): IngestBudget | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return budgets.find((b) => s(b.name).toLowerCase() === n) ?? null
}

/** Parse a capacity value into whole bytes. Blank/non-numeric/non-positive → undefined. */
export function toCapacityBytes(value: unknown): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return undefined
  return Math.trunc(n)
}

/** Build the create/update request body from canvas fields — the full definition on every write. */
export function buildIngestBudgetBody(fields: Record<string, unknown>): IngestBudget {
  const body: IngestBudget = {
    name: s(fields.name),
    scope: s(fields.scope),
    capacityBytes: toCapacityBytes(fields.capacityBytes) ?? 0,
    action: s(fields.action) || 'keepCollecting',
  }
  body.timezone = s(fields.timezone) || 'Etc/UTC'
  body.resetTime = s(fields.resetTime) || '00:00'
  body.description = s(fields.description)
  const auditThreshold = Number(fields.auditThreshold)
  if (Number.isFinite(auditThreshold) && auditThreshold >= 1 && auditThreshold <= 99) {
    body.auditThreshold = Math.trunc(auditThreshold)
  }
  return body
}
