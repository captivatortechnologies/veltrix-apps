// Shared helpers for the Sumo Logic Data Forwarding Rules config type
// (deploy + rollback + drift + validate).
//
// A data forwarding rule binds a Partition or Scheduled View (by its own `id`,
// the `indexId`) to a Data Forwarding Destination. Unlike every other config
// type in this app, the identity (`indexId`) is CALLER-SUPPLIED — it is the id
// of an existing Partition or Scheduled View, not something Sumo Logic
// assigns — so this reconciles by `indexId` directly rather than matching a
// declared name against a list. The list endpoint's continuation token is
// named `nextToken` (not `next`).
//   API: https://help.sumologic.com/docs/api/data-forwarding/
//   Verified against the official Sumo Logic OpenAPI spec
//   (CreateDataForwardingRule / UpdateDataForwardingRule,
//   api.sumologic.com/docs/sumologic-api.yaml).

/** One Sumo Logic data forwarding rule. */
export interface DataForwardingRule {
  id?: string
  /** The id of the Partition or Scheduled View this rule applies to — the identity. */
  indexId: string
  /** The Data Forwarding Destination id. */
  destinationId: string
  enabled?: boolean
  /** Path prefix / file naming pattern, e.g. {index}_{day}_{hour}_{minute}_{second}. */
  fileFormat?: string
  /** builtInFields | allFields | raw. */
  payloadSchema?: string
  /** csv | json | text. */
  format?: string
  [key: string]: unknown
}

/** The { data: [...], nextToken } envelope returned by GET /logsDataForwarding/rules. */
export interface DataForwardingRuleList {
  data?: DataForwardingRule[]
  nextToken?: string | null
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a checkbox/string value to a boolean. Defaults to true when unset. */
export function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = s(value).toLowerCase()
  if (v === 'false' || v === '0' || v === 'no') return false
  return true
}

/** Unwrap the { data: [...] } list envelope into a flat array of rules. */
export function rulesFromList(list: unknown): DataForwardingRule[] {
  if (Array.isArray(list)) return list as DataForwardingRule[]
  const data = (list as DataForwardingRuleList | null | undefined)?.data
  return Array.isArray(data) ? data : []
}

/** Find a live rule by its indexId (the identity — the bound Partition/Scheduled View id). */
export function findRuleByIndexId(rules: DataForwardingRule[], indexId: string): DataForwardingRule | null {
  const n = indexId.trim()
  if (!n) return null
  return rules.find((r) => s(r.indexId) === n) ?? null
}

/** Create-request body — includes indexId/destinationId (both required on create). */
export function buildRuleCreateBody(fields: Record<string, unknown>): DataForwardingRule {
  const body: DataForwardingRule = {
    indexId: s(fields.indexId),
    destinationId: s(fields.destinationId),
    enabled: normalizeEnabled(fields.enabled),
  }
  if (s(fields.fileFormat)) body.fileFormat = s(fields.fileFormat)
  if (s(fields.payloadSchema)) body.payloadSchema = s(fields.payloadSchema)
  if (s(fields.format)) body.format = s(fields.format)
  return body
}

/** Update-request body — everything except indexId (it lives in the path). */
export function buildRuleUpdateBody(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    destinationId: s(fields.destinationId),
    enabled: normalizeEnabled(fields.enabled),
  }
  if (s(fields.fileFormat)) body.fileFormat = s(fields.fileFormat)
  if (s(fields.payloadSchema)) body.payloadSchema = s(fields.payloadSchema)
  if (s(fields.format)) body.format = s(fields.format)
  return body
}
