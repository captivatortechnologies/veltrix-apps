// Shared helpers for the Cortex XDR Indicators (IOCs) config type
// (deploy + rollback + drift).
//
// IOC shapes and endpoint paths below follow the Cortex XDR public API v1
// conventions. The exact endpoint paths, request/response field names and enum
// values are FLAGGED — VERIFY every one against a live Cortex XDR tenant before
// relying on it in production.

// --- Cortex XDR indicators endpoints (VERIFY against live Cortex XDR) ---------
// All are POST under /public_api/v1. The client prepends the base + /public_api/v1.
export const IOC_ENDPOINTS = {
  /** Upsert IOCs. Body: { request_data: [ <ioc>, … ] } (ARRAY form). VERIFY. */
  insert: '/indicators/insert_jsons/',
  /** Read IOCs changed since a timestamp. Body: { request_data: { ts: <epoch ms> } }. VERIFY. */
  getChanges: '/indicators/get_changes/',
  /** Delete IOCs. Body: { request_data: { indicators: [ <value>, … ] } }. VERIFY. */
  delete: '/indicators/delete/',
} as const

/** Accepted indicator types (VERIFY against live Cortex XDR). */
export const IOC_TYPES = new Set(['HASH', 'IP', 'DOMAIN_NAME', 'PATH', 'FILENAME'])
/** Accepted severities (VERIFY against live Cortex XDR). */
export const IOC_SEVERITIES = new Set(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
/** Accepted reputations (VERIFY against live Cortex XDR). */
export const IOC_REPUTATIONS = new Set(['GOOD', 'BAD', 'SUSPICIOUS', 'UNKNOWN'])
/** Accepted reliability grades — Admiralty scale A–F (VERIFY against live Cortex XDR). */
export const IOC_RELIABILITIES = new Set(['A', 'B', 'C', 'D', 'E', 'F'])

/**
 * One Cortex XDR indicator, as sent to insert_jsons and (approximately) as read
 * back from get_changes. Field names are FLAGGED — VERIFY against live Cortex XDR.
 */
export interface CortexIoc {
  indicator?: string
  type?: string
  severity?: string
  reputation?: string
  reliability?: string
  comment?: string
  /** Unix epoch MILLISECONDS, or null/-1 for never. VERIFY units against live Cortex XDR. */
  expiration_date?: number | null
  [key: string]: unknown
}

/** Trim + lowercase an indicator value so two that differ only in case still match. */
export function normalizeIndicator(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Cortex get_changes returns its payload on `reply`; the exact shape is FLAGGED.
 * We accept either a bare array of IOCs on `reply`, or `{ reply: { indicators: [] } }`.
 * VERIFY the real shape against live Cortex XDR.
 */
export function iocsFromReply(reply: unknown): CortexIoc[] {
  if (Array.isArray(reply)) return reply as CortexIoc[]
  if (reply && typeof reply === 'object') {
    const inner = (reply as Record<string, unknown>).indicators
    if (Array.isArray(inner)) return inner as CortexIoc[]
  }
  return []
}

/** Find a live IOC by its (normalized) indicator value. */
export function findIoc(iocs: CortexIoc[], indicator: string): CortexIoc | null {
  const target = normalizeIndicator(indicator)
  if (!target) return null
  return iocs.find((i) => normalizeIndicator(i.indicator) === target) ?? null
}

/**
 * Parse the optional expiration_date (epoch millis) from a canvas field. Returns
 * a number when a positive integer string/number is present, otherwise null.
 */
export function parseExpiration(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Build the Cortex XDR IOC body from canvas fields. Omits empty optional fields. */
export function buildIocFields(fields: Record<string, unknown>): CortexIoc {
  const ioc: CortexIoc = {
    indicator: String(fields.indicator ?? '').trim(),
    type: String(fields.type ?? '').trim(),
    severity: String(fields.severity ?? '').trim(),
  }
  const reputation = String(fields.reputation ?? '').trim()
  if (reputation) ioc.reputation = reputation
  const reliability = String(fields.reliability ?? '').trim()
  if (reliability) ioc.reliability = reliability
  const comment = String(fields.comment ?? '').trim()
  if (comment) ioc.comment = comment
  const expiration = parseExpiration(fields.expiration_date)
  if (expiration !== null) ioc.expiration_date = expiration
  return ioc
}
