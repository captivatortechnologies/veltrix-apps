// =============================================================================
// Shared IPv4 CIDR + port helpers.
//
// Used by ACS config types that manage subnet/port lists (outbound-ports and
// future types). Kept in lib/ so config types depend on a shared module rather
// than importing one another's validate.ts. The ip-allowlists type predates this
// and keeps its own local copies; new types use these.
// =============================================================================

const CIDR_V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/

/** Validate an IPv4 CIDR (octets 0–255, prefix 0–32). */
export function isValidIpv4Cidr(value: string): boolean {
  const match = CIDR_V4_RE.exec(value)
  if (!match) return false
  const octets = match.slice(1, 5).map(Number)
  const prefix = Number(match[5])
  return octets.every((o) => o >= 0 && o <= 255) && prefix >= 0 && prefix <= 32
}

/** Normalize a subnet from an ACS response (strips list markers/whitespace). */
export function normalizeSubnet(value: string): string {
  return value.replace(/^[\s:]+/, '').trim()
}

/** The CIDR prefix length (bits) of an IPv4 CIDR, or null if malformed. */
export function cidrPrefix(value: string): number | null {
  const slash = value.indexOf('/')
  if (slash < 0) return null
  const prefix = Number(value.slice(slash + 1))
  return Number.isFinite(prefix) ? prefix : null
}

/** Validate a TCP/UDP port number (1–65535). */
export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

/** Coerce a canvas field (number or numeric string) to a port number, or null. */
export function coercePort(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Number(raw)
  }
  return null
}
