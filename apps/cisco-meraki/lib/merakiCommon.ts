// =============================================================================
// Shared helpers used across every Cisco Meraki config type (l3/l7 firewall
// rules, group policies, appliance VLANs). Pulled out once a second network-
// scoped config type needed the same network-id validation and order/key
// sensitive JSON comparison that l3-firewall-rules introduced in v0.1.0 — see
// config-types/l3-firewall-rules/_shared.ts, which now re-exports these rather
// than duplicating them.
// =============================================================================

/** Meraki network ids are opaque tokens (letters, digits, underscore, hyphen). */
export const NETWORK_ID_RE = /^[A-Za-z0-9_-]+$/
/** Every network id observed in the wild starts with one of these prefixes. */
const KNOWN_ID_PREFIX_RE = /^(L|N)_/

/** Does this network id look like a known Meraki id shape ("L_..." / "N_...")? Advisory only. */
export function looksLikeKnownNetworkId(id: string): boolean {
  return KNOWN_ID_PREFIX_RE.test(id)
}

/** A network id's logical identity for de-duplication: trimmed, case preserved. */
export function networkIdKey(id: string): string {
  return id.trim()
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * Stable, key-sorted JSON of a value — for ORDER-SENSITIVE drift comparison
 * (arrays keep their order; only object keys are sorted so key order never
 * causes a false diff).
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) return null
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(sort)
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sort((v as Record<string, unknown>)[k])
        return acc
      }, {})
  }
  return JSON.stringify(sort(value))
}

/** A subset of `source` limited to `keys` — for comparing only the fields we declare. */
export function pickKeys(source: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!source) return out
  for (const k of keys) if (k in source) out[k] = source[k]
  return out
}

/**
 * Parse a JSON textarea into a plain object (rejects arrays and primitives).
 * Used for a config type's free-form JSON blob (e.g. a group policy's nested
 * scheduling/bandwidth/firewall settings, or a VLAN's advanced settings).
 */
export function parseJsonObject(raw: unknown, label: string): { value: Record<string, unknown> | null; error: string | null } {
  const text = String(raw ?? '').trim()
  if (!text) return { value: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { value: null, error: `${label} is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: `${label} must be a JSON object.` }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}
