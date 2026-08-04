// Shared helpers for the Akamai Edge DNS Zones config type. Shapes follow the
// Edge DNS API v2 (GET/POST/PUT /config-dns/v2/zones[/{zone}]). Unlike Network
// Lists / Client Lists, a zone's NAME *is* its URL identity — there is no
// server-assigned opaque id to resolve first, so deploy/rollback/drift all GET
// the zone directly by name instead of listing-then-matching.

/** Valid zone types. `masters` is required for SECONDARY; `target` for ALIAS. */
export const ZONE_TYPES = new Set(['PRIMARY', 'SECONDARY', 'ALIAS'])

/** DNSSEC signing algorithms accepted by `signAndServeAlgorithm`. */
export const SIGN_ALGORITHMS = new Set(['RSA_SHA1', 'RSA_SHA256', 'RSA_SHA512', 'ECDSA_P256_SHA256', 'ECDSA_P384_SHA384'])

/** A zone as the Edge DNS API returns/accepts it (fields we rely on, plus passthrough). */
export interface DnsZone {
  zone?: string
  type?: string
  masters?: string[]
  comment?: string
  signAndServe?: boolean
  signAndServeAlgorithm?: string
  target?: string
  endCustomerId?: string
  contractId?: string
  tsigKey?: unknown
  outboundZoneTransfer?: unknown
  activationState?: string
  versionId?: string
  [key: string]: unknown
}

/** Normalize a zone type value to PRIMARY/SECONDARY/ALIAS (defaults to PRIMARY). */
export function normalizeZoneType(value: unknown): string {
  const t = String(value ?? '').trim().toUpperCase()
  return ZONE_TYPES.has(t) ? t : 'PRIMARY'
}

/** Parse a `tags`/textarea/comma-list field into a clean, de-duplicated, trimmed string array. */
export function parseStringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((v) => String(v)) : String(value ?? '').split(/[\r\n,]+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const e = entry.trim()
    if (!e || seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out
}

/**
 * Parse the optional `advanced` JSON textarea — carries the rarely-used nested
 * objects the create/update body also accepts (`tsigKey` for secondary zones,
 * `outboundZoneTransfer` for transfer-out config) without a canvas field per
 * nested property. Returns `{}` for blank input; throws a descriptive error on
 * malformed JSON or a non-object value.
 */
export function parseAdvanced(value: unknown): Record<string, unknown> {
  const raw = String(value ?? '').trim()
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Advanced options must be valid JSON: ${error instanceof Error ? error.message : 'parse error'}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Advanced options must be a JSON object (e.g. {"tsigKey": {...}}).')
  }
  return parsed as Record<string, unknown>
}

export interface DnsZoneFields {
  zone: string
  type: string
  contractId: string
  groupId: string
  comment: string
  masters: string[]
  target: string
  signAndServe: boolean
  signAndServeAlgorithm: string
  endCustomerId: string
  advanced: Record<string, unknown>
}

/** Read + normalize the canvas fields for one zone item. Throws if `advanced` is malformed JSON. */
export function readZoneFields(fields: Record<string, unknown>): DnsZoneFields {
  return {
    zone: String(fields.zone ?? '').trim().toLowerCase(),
    type: normalizeZoneType(fields.type),
    contractId: String(fields.contractId ?? '').trim(),
    groupId: String(fields.groupId ?? '').trim(),
    comment: String(fields.comment ?? '').trim(),
    masters: parseStringList(fields.masters),
    target: String(fields.target ?? '').trim(),
    signAndServe: fields.signAndServe === true,
    signAndServeAlgorithm: String(fields.signAndServeAlgorithm ?? '').trim().toUpperCase(),
    endCustomerId: String(fields.endCustomerId ?? '').trim(),
    advanced: parseAdvanced(fields.advanced),
  }
}

/** Build the zone create/update request body — typed fields win over `advanced` on key collision. */
export function buildZoneBody(f: DnsZoneFields): Record<string, unknown> {
  const body: Record<string, unknown> = { ...f.advanced, zone: f.zone, type: f.type, signAndServe: f.signAndServe }
  if (f.comment) body.comment = f.comment
  if (f.type === 'SECONDARY' && f.masters.length) body.masters = f.masters
  if (f.type === 'ALIAS' && f.target) body.target = f.target
  if (f.signAndServe && SIGN_ALGORITHMS.has(f.signAndServeAlgorithm)) body.signAndServeAlgorithm = f.signAndServeAlgorithm
  if (f.endCustomerId) body.endCustomerId = f.endCustomerId
  if (f.contractId) body.contractId = f.contractId
  return body
}

/** The zone-scoped path: `/config-dns/v2/zones/{zone}`. */
export function zonePath(zone: string): string {
  return `/config-dns/v2/zones/${encodeURIComponent(zone)}`
}

/** Writable zone keys — everything else on a GET response (aliasCount, activationState, …) is computed/read-only. */
const WRITABLE_ZONE_KEYS = [
  'zone',
  'type',
  'masters',
  'comment',
  'signAndServe',
  'signAndServeAlgorithm',
  'tsigKey',
  'target',
  'endCustomerId',
  'contractId',
  'outboundZoneTransfer',
] as const

/** Rebuild a PUT-able body from a prior GET response, stripping computed/read-only fields (rollback restore). */
export function buildZoneBodyFromPrior(prior: DnsZone): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const key of WRITABLE_ZONE_KEYS) {
    if (prior[key] !== undefined) body[key] = prior[key]
  }
  return body
}
