// Shared helpers for the Password Safe Address Groups config type (deploy +
// rollback + drift). Pure and network-free — the __tests__ exercise validate.ts
// and these helpers, none of which touch the network.
//
// An Address Group is a named collection of IP addresses / ranges used to
// scope Password Safe access policies and Smart Rules — a genuinely
// declarative, secret-free resource with FULL CRUD on both the group and its
// member addresses:
//   GET/POST/PUT/DELETE  /AddressGroups            the group itself (Name)
//   GET/POST/DELETE      /AddressGroups/{id}/Addresses   member IP entries
//   DELETE               /Addresses/{id}                 remove one member entry
//
// Each declared address (one canvas "tag") is passed through to the API
// VERBATIM as IPAddress — Password Safe's own format accepts a single IP, a
// CIDR/range, or a comma-delimited list in one IPAddress value, so this app
// does not split or re-parse an entry client-side.
//
// Membership is AUTHORITATIVE: the declared address list is reconciled
// against the live one on every deploy (add what's missing, remove what's no
// longer declared) — unlike the create-if-absent config types elsewhere in
// this app, because AddressGroups have no secret material and full CRUD, a
// stronger "declared list is the truth" semantic is safe here.
//
// Endpoints follow the BeyondInsight / Password Safe public v3 API — verify
// against a live BeyondTrust instance.

/** One address group as returned by GET /AddressGroups. */
export interface AddressGroup {
  AddressGroupID?: number | string
  Name?: string
  [key: string]: unknown
}

/** One member address as returned by GET /AddressGroups/{id}/Addresses. */
export interface AddressEntry {
  AddressID?: number | string
  IPAddress?: string
  [key: string]: unknown
}

/** Trim any value to a string. */
export function str(value: unknown): string {
  return String(value ?? '').trim()
}

/** Unwrap either a plain array or a `{ Data: [...] }` paginated container. */
export function listFrom<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object' && Array.isArray((data as { Data?: unknown }).Data)) {
    return (data as { Data: T[] }).Data
  }
  return []
}

/** Find a live address group by its (case-insensitive) name. */
export function findAddressGroupByName(groups: AddressGroup[], name: string): AddressGroup | null {
  const wanted = name.trim().toLowerCase()
  return groups.find((g) => str(g.Name).toLowerCase() === wanted) ?? null
}

/** The declared address list from a "tags" canvas field, trimmed and deduplicated (order-preserving, case-insensitive). */
export function declaredAddresses(value: unknown): string[] {
  const list = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const addr = str(raw)
    if (!addr) continue
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(addr)
  }
  return out
}

/** The live address strings on a group, trimmed (order as returned by the API). */
export function liveAddresses(entries: AddressEntry[]): string[] {
  return entries.map((e) => str(e.IPAddress)).filter(Boolean)
}

/**
 * Diff a declared address list against the live entries: which declared
 * addresses are missing (need POST) and which live entries are no longer
 * declared (need DELETE, keeping their AddressID for the call).
 */
export function diffAddresses(
  declared: string[],
  live: AddressEntry[],
): { toAdd: string[]; toRemove: AddressEntry[] } {
  const declaredKeys = new Set(declared.map((a) => a.toLowerCase()))
  const liveKeys = new Set(live.map((e) => str(e.IPAddress).toLowerCase()))
  const toAdd = declared.filter((a) => !liveKeys.has(a.toLowerCase()))
  const toRemove = live.filter((e) => !declaredKeys.has(str(e.IPAddress).toLowerCase()))
  return { toAdd, toRemove }
}
