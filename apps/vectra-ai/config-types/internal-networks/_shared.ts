// Shared helpers for the Vectra Internal Networks config type (deploy + rollback +
// drift).
//
// A brain-wide SINGLETON: GET/POST /settings/internal_network (v2.5, 443). Shapes
// follow Vectra's official client (vectra_api_tools, VectraBaseClient):
//   read:  GET  /settings/internal_network  → { included_subnets, excluded_subnets, dropped_subnets }
//   write: POST /settings/internal_network  body { include, exclude, drop }  (FULL REPLACE)
//
// FLAG (verify against a live Vectra): the GET response and the POST request use
// DIFFERENT key names for the same three lists (included_subnets / excluded_subnets /
// dropped_subnets on read vs include / exclude / drop on write) — confirmed from
// Vectra's official Python client, not yet confirmed against a live brain's raw wire
// response. The write is a FULL REPLACE of all three lists (this config type does
// NOT use the client's optional client-side "append" merge) — the declared item is
// the COMPLETE desired set; anything present on the brain but not declared here is
// removed. There is no per-entry create/delete — one canvas item is the whole
// brain-wide configuration.

export interface InternalNetworksState {
  include: string[]
  exclude: string[]
  drop: string[]
}

const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/

/** Loose IPv4 address or CIDR shape check — Vectra is the final authority. */
export function isIpOrCidr(value: string): boolean {
  const m = CIDR_RE.exec(value.trim())
  if (!m) return false
  if ([m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) return false
  if (m[5] && Number(m[5].slice(1)) > 32) return false
  return true
}

/** Split a comma/whitespace-separated field into a trimmed, de-duplicated list. */
export function parseSubnetList(value: unknown): string[] {
  const seen = new Set<string>()
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !seen.has(s) && (seen.add(s), true))
}

/** Read the live internal-network settings, remapped from the GET response's key names. */
export function stateFromGet(body: unknown): InternalNetworksState {
  const o = (body ?? {}) as Record<string, unknown>
  const toList = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [])
  return {
    include: toList(o.included_subnets),
    exclude: toList(o.excluded_subnets),
    drop: toList(o.dropped_subnets),
  }
}

/** Build the declared desired state (POST body key names) from canvas fields. */
export function buildDesiredState(fields: Record<string, unknown>): InternalNetworksState {
  return {
    include: parseSubnetList(fields.include),
    exclude: parseSubnetList(fields.exclude),
    drop: parseSubnetList(fields.drop),
  }
}

/** Order-insensitive comparison key for a subnet list. */
export function sortedJoin(list: string[]): string {
  return [...list].sort().join(', ')
}

/** Whole-state equality, order-insensitive per list. */
export function statesEqual(a: InternalNetworksState, b: InternalNetworksState): boolean {
  return (
    sortedJoin(a.include) === sortedJoin(b.include) &&
    sortedJoin(a.exclude) === sortedJoin(b.exclude) &&
    sortedJoin(a.drop) === sortedJoin(b.drop)
  )
}
