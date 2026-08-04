// Shared helpers for the Akamai Edge DNS Recordsets config type. Shapes follow
// the Edge DNS API v2 per-record endpoints (GET/POST/PUT/DELETE
// /config-dns/v2/zones/{zone}/names/{name}/types/{type}). The real API is
// deliberately generic: every record type is `{ name, type, ttl, rdata }`
// where `rdata` is a raw array of presentation-format strings — there is no
// per-type field breakdown server-side (Terraform's per-type schema is a
// client-side convenience Edge DNS itself doesn't require), so this config
// type mirrors the API's own shape rather than inventing one field per record
// type. The (zone, name, type) TRIPLE is the real identity — like Network List
// Activation, `identityField` names one field (`name`) for the canvas even
// though matching/upsert keys off all three.

/**
 * Selectable record types. AKAMAITLC / AKAMAITLC-alike answer-assignment
 * records are Akamai-managed (created by CNAME chaining, not user-authored)
 * and are intentionally excluded — Akamai documents them as effectively
 * read-only. SOA is excluded too: it is auto-created with the zone and Edge
 * DNS does not expect a user-authored duplicate.
 */
export const RECORD_TYPES = [
  'A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SPF', 'SRV', 'CAA', 'PTR',
  'NAPTR', 'SSHFP', 'TLSA', 'DS', 'DNSKEY', 'CERT', 'HINFO', 'RP',
  'HTTPS', 'SVCB', 'NSEC3', 'NSEC3PARAM', 'AFSDB', 'RRSIG', 'LOC',
] as const
export const RECORD_TYPE_SET = new Set<string>(RECORD_TYPES)

/** A recordset as the Edge DNS API returns/accepts it. */
export interface DnsRecord {
  name?: string
  type?: string
  ttl?: number
  active?: boolean
  rdata?: string[]
  [key: string]: unknown
}

/** Normalize a record type value (upper-cased; caller validates membership in RECORD_TYPE_SET). */
export function normalizeRecordType(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

/**
 * Parse the `rdata` textarea into a clean, order-preserving list of trimmed
 * lines. Unlike Network List elements, rdata is NOT de-duplicated or
 * upper-cased — presentation-format rdata is type-specific (e.g. a TXT value
 * legitimately repeats, case matters in some fields) and Edge DNS itself is
 * the source of truth for validity.
 */
export function parseRdata(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((v) => String(v)) : String(value ?? '').split(/\r?\n/)
  return raw.map((line) => line.trim()).filter((line) => line.length > 0)
}

export interface DnsRecordFields {
  zone: string
  name: string
  recordType: string
  ttl: number
  rdata: string[]
}

/** Read + normalize the canvas fields for one recordset item. */
export function readRecordFields(fields: Record<string, unknown>): DnsRecordFields {
  const ttlRaw = fields.ttl
  const ttl = typeof ttlRaw === 'number' && Number.isFinite(ttlRaw) && ttlRaw >= 0 ? Math.trunc(ttlRaw) : 300
  return {
    zone: String(fields.zone ?? '').trim().toLowerCase(),
    name: String(fields.name ?? '').trim().toLowerCase(),
    recordType: normalizeRecordType(fields.recordType),
    ttl,
    rdata: parseRdata(fields.rdata),
  }
}

/** Build the recordset create/update request body. */
export function buildRecordBody(f: DnsRecordFields): Record<string, unknown> {
  return { name: f.name, type: f.recordType, ttl: f.ttl, rdata: f.rdata }
}

/** The record-scoped path: `/config-dns/v2/zones/{zone}/names/{name}/types/{type}`. */
export function recordPath(zone: string, name: string, recordType: string): string {
  return `/config-dns/v2/zones/${encodeURIComponent(zone)}/names/${encodeURIComponent(name)}/types/${encodeURIComponent(recordType)}`
}

/** Order-insensitive equality of two rdata lists. */
export function sameRdata(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bSorted = [...b].sort()
  const aSorted = [...a].sort()
  return aSorted.every((v, i) => v === bSorted[i])
}
