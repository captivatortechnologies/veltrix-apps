// =============================================================================
// Shared spec/validation helpers reused across every Check Point config type
// (network-hosts, network-objects, service-objects, access-rules). Kept here
// — not duplicated per config type, not cross-imported between sibling config
// type folders — so a fix (e.g. a better IPv6 matcher) lands everywhere at once.
// =============================================================================

/** Read a canvas value that may be a `tags` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** An object's logical identity: its name, case-insensitive and trimmed. */
export function objectKey(name: string): string {
  return name.trim().toLowerCase()
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isValidIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

// A pragmatic (not exhaustively RFC 4291-complete) IPv6 matcher: full and
// zero-compressed ("::") forms, including an embedded IPv4 tail and zone id.
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))$/

export function isValidIpv6(value: string): boolean {
  return IPV6_RE.test(value)
}

/** Flatten a live member list (plain strings or { name } object summaries) to names. */
export function liveTagNames(tags: Array<string | { name?: string }> | undefined): string[] {
  if (!Array.isArray(tags)) return []
  return tags
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
}

/** Case-insensitive set-equality for two name/id lists. */
export function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a.map((s) => s.toLowerCase()))
  return b.every((s) => setA.has(s.toLowerCase()))
}
