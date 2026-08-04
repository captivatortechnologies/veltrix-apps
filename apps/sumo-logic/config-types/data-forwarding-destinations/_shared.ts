// Shared helpers for the Sumo Logic Data Forwarding Destinations config type
// (deploy + rollback + drift + validate).
//
// A destination is an Amazon S3 bucket Sumo Logic can archive/forward log data
// to, authenticated either with an AWS access key pair or an IAM role ARN.
// `bucketName` is a CREATE-ONLY field — the official OpenAPI's
// `UpdateBucketDefinition` does not accept it, only `CreateBucketDefinitionItems`
// (create) does — so this type upserts by `destinationName` but only ever sends
// the mutable subset on update. The list endpoint's continuation token is named
// `nextToken` (not `next`, unlike most other list endpoints in this app).
//   API: https://help.sumologic.com/docs/api/data-forwarding/
//   Verified against the official Sumo Logic OpenAPI spec
//   (CreateBucketDefinition / UpdateBucketDefinition,
//   api.sumologic.com/docs/sumologic-api.yaml).

/** One Sumo Logic S3 data forwarding destination. */
export interface DataForwardingDestination {
  id?: string
  /** Name of the destination — the stable identity used to upsert. */
  destinationName: string
  description?: string
  /** Name of the S3 bucket. CREATE-ONLY — Sumo Logic rejects it on update. */
  bucketName: string
  /** AccessKey or RoleBased. */
  authenticationMode: string
  accessKeyId?: string
  secretAccessKey?: string
  roleArn?: string
  region?: string
  encrypted?: boolean
  enabled?: boolean
  invalidatedBySystem?: boolean
  [key: string]: unknown
}

/** The { data: [...], nextToken } envelope returned by GET /logsDataForwarding/destinations. */
export interface DataForwardingDestinationList {
  data?: DataForwardingDestination[]
  nextToken?: string | null
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a checkbox/string value to a boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = s(value).toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/** Unwrap the { data: [...] } list envelope into a flat array of destinations. */
export function destinationsFromList(list: unknown): DataForwardingDestination[] {
  if (Array.isArray(list)) return list as DataForwardingDestination[]
  const data = (list as DataForwardingDestinationList | null | undefined)?.data
  return Array.isArray(data) ? data : []
}

/** Find a live destination by name (case-insensitive, trimmed) — the identity. */
export function findDestination(destinations: DataForwardingDestination[], destinationName: string): DataForwardingDestination | null {
  const n = destinationName.trim().toLowerCase()
  if (!n) return null
  return destinations.find((d) => s(d.destinationName).toLowerCase() === n) ?? null
}

/** Create-request body — the only place `bucketName` is ever sent. */
export function buildDestinationCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return { ...buildDestinationUpdateBody(fields), bucketName: s(fields.bucketName) }
}

/** Update-request body — the mutable subset (everything except `bucketName`). */
export function buildDestinationUpdateBody(fields: Record<string, unknown>): Record<string, unknown> {
  const mode = s(fields.authenticationMode) || 'RoleBased'
  const body: Record<string, unknown> = {
    destinationName: s(fields.destinationName),
    description: s(fields.description),
    authenticationMode: mode,
    enabled: normalizeBool(fields.enabled ?? true),
    encrypted: normalizeBool(fields.encrypted),
  }
  if (s(fields.region)) body.region = s(fields.region)
  if (mode === 'AccessKey') {
    if (s(fields.accessKeyId)) body.accessKeyId = s(fields.accessKeyId)
    if (s(fields.secretAccessKey)) body.secretAccessKey = s(fields.secretAccessKey)
  } else {
    if (s(fields.roleArn)) body.roleArn = s(fields.roleArn)
  }
  return body
}

/**
 * Restore-request body for rollback, rebuilt from a prior destination snapshot
 * (a live GET result). SECRET LIMITATION: `accessKeyId`/`secretAccessKey` are
 * intentionally excluded — Sumo Logic never echoes them back on read, so a
 * captured "prior" snapshot has nothing genuine to restore. A destination whose
 * credentials changed keeps whichever ones the deploy set; the previous
 * AccessKey pair cannot be recovered and must be re-entered by an operator if
 * needed. `bucketName` is also excluded (update-only rejects it; restoring a
 * changed destination never needs to touch it since bucketName cannot change).
 */
export function buildDestinationRestoreBody(prior: DataForwardingDestination): Record<string, unknown> {
  const body: Record<string, unknown> = {
    destinationName: s(prior.destinationName),
    description: s(prior.description),
    authenticationMode: s(prior.authenticationMode) || 'RoleBased',
    enabled: prior.enabled !== false,
    encrypted: Boolean(prior.encrypted),
  }
  if (s(prior.region)) body.region = s(prior.region)
  if (s(prior.authenticationMode) === 'RoleBased' && s(prior.roleArn)) body.roleArn = s(prior.roleArn)
  return body
}
