// =============================================================================
// Shared helpers for the Firewall Aliases config type (validate + deploy +
// rollback + drift). Field shapes and validation rules mirror pfSense's own
// FirewallAlias Model (RESTAPI/Models/FirewallAlias.inc) and the native
// `is_validaliasname()` / `is_port_or_range()` helpers in pfSense's own
// src/etc/inc/util.inc — see the inline citations below.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { FirewallAlias } from '../../lib/pfsenseApi'

/** `maximum_length: 31` on FirewallAlias::$name (RESTAPI/Models/FirewallAlias.inc). */
export const MAX_NAME_LENGTH = 31
/** `descr` has no override — inherits StringField's default `maximum_length: 1024`. */
export const MAX_DESCRIPTION_LENGTH = 1024

export type AliasType = 'host' | 'network' | 'port'
export const ALIAS_TYPES: AliasType[] = ['host', 'network', 'port']

/**
 * Words `is_validaliasname()` rejects outright (src/etc/inc/util.inc) — exact,
 * case-sensitive strict match, same as pfSense's own `in_array($name,
 * $reserved, true)`.
 */
export const RESERVED_EXACT_WORDS = ['port', 'pass']

/**
 * A best-effort, NON-EXHAUSTIVE subset of the names pfSense's
 * FilterNameValidator additionally rejects via `get_pf_reserved()` — that
 * function is dynamic (it includes every configured interface's name, which
 * this app cannot see from a schema-only validate step). Listed here purely
 * as a client-side WARNING to catch the most common collisions before a round
 * trip; the REST API package is the final authority and will reject anything
 * this list misses.
 */
export const KNOWN_RESERVED_NAME_HINTS = [
  'wan',
  'lan',
  'opt1',
  'opt2',
  'sshguard',
  'openvpn',
  'ipsec',
  'l2tp',
  'pppoe',
  'enc0',
  'pflog0',
  'pfsync0',
]

/** One firewall alias item, normalized from canvas fields. */
export interface AliasSpec {
  itemId?: string
  name: string
  type: AliasType | ''
  descr: string
  address: string[]
  detail: string[]
}

function strList(value: unknown): string[] {
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

/** Read one canvas item's fields into a normalized alias spec. */
export function specFromItem(item: CanvasItemSnapshot): AliasSpec {
  const f = item.fields ?? {}
  const rawType = String(f.type ?? '').trim()
  return {
    itemId: item.id,
    name: String(f.name ?? '').trim(),
    type: (ALIAS_TYPES as string[]).includes(rawType) ? (rawType as AliasType) : '',
    descr: String(f.descr ?? '').trim(),
    address: strList(f.address),
    detail: strList(f.detail),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): AliasSpec[] {
  return items.map(specFromItem)
}

/**
 * Alias-name identity — EXACT match, case-SENSITIVE. Unlike some other
 * apps in this codebase (Check Point, Cisco ISE) that fold case for their
 * object identity, pfSense's `is_validaliasname()` charset check
 * (`/[^a-z0-9_]/i`) is case-preserving and `MyAlias` / `myalias` are two
 * distinct, independently valid alias names in pfSense — folding case here
 * would incorrectly treat them as the same object.
 */
export function aliasKey(name: string): string {
  return name.trim()
}

/** The full create-request body for a spec. Callers updating an EXISTING alias must drop `name` — see updateAlias. */
export interface AliasWriteBody {
  name: string
  type: AliasType
  descr: string
  address: string[]
  detail: string[]
}

export function toAliasBody(spec: AliasSpec): AliasWriteBody {
  return {
    name: spec.name,
    type: spec.type as AliasType,
    descr: spec.descr,
    address: spec.address,
    detail: spec.detail,
  }
}

/** Snapshot a live alias's managed fields for rollback (everything PATCH/rollback can restore). */
export function snapshotAlias(live: FirewallAlias): Omit<FirewallAlias, 'id' | 'name'> {
  return {
    type: live.type,
    descr: live.descr ?? '',
    address: Array.isArray(live.address) ? live.address : [],
    detail: Array.isArray(live.detail) ? live.detail : [],
  }
}

// --- Field-level validation (mirrors pfSense's own rules; see validate.ts) ---

/** `is_validaliasname()` charset — letters, digits, underscore only (src/etc/inc/util.inc). */
const NAME_CHARSET_RE = /^[A-Za-z0-9_]+$/
const ALL_DIGITS_RE = /^\d+$/
const ALL_UNDERSCORES_RE = /^_+$/

export interface NameValidation {
  valid: boolean
  error?: string
  /** A best-effort hint, not a hard rule — see KNOWN_RESERVED_NAME_HINTS. */
  warning?: string
}

/** Client-side mirror of `is_validaliasname()` + FilterNameValidator's static rules. */
export function validateAliasName(name: string): NameValidation {
  if (!name) return { valid: false, error: 'Name is required.' }
  if (name.length > MAX_NAME_LENGTH) {
    return { valid: false, error: `Name must be ${MAX_NAME_LENGTH} characters or fewer (got ${name.length}).` }
  }
  if (ALL_DIGITS_RE.test(name)) return { valid: false, error: 'Name may not consist of only numbers.' }
  if (ALL_UNDERSCORES_RE.test(name)) return { valid: false, error: 'Name may not consist of only underscores.' }
  if (!NAME_CHARSET_RE.test(name)) {
    return { valid: false, error: 'Name may only contain letters, numbers and underscores (a-z, A-Z, 0-9, _).' }
  }
  if (RESERVED_EXACT_WORDS.includes(name)) {
    return { valid: false, error: `Name must not be the reserved word "${name}".` }
  }
  if (name.startsWith('pkg_')) return { valid: false, error: 'Name must not start with "pkg_" (reserved for packages).' }
  if (KNOWN_RESERVED_NAME_HINTS.includes(name.toLowerCase())) {
    return {
      valid: true,
      warning: `"${name}" looks like a system-reserved name (an interface or built-in table). pfSense's ` +
        'full reserved-name list is dynamic (depends on your configured interfaces) and can only be checked ' +
        'authoritatively on deploy — this is a best-effort hint.',
    }
  }
  return { valid: true }
}

/** IPv4 dotted-quad, no CIDR. */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
export function isValidIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

/** A pragmatic (not exhaustively RFC 4291) IPv6 matcher — full and "::"-compressed forms. */
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))$/
export function isValidIpv6(value: string): boolean {
  return IPV6_RE.test(value)
}

export function isValidIp(value: string): boolean {
  return isValidIpv4(value) || isValidIpv6(value)
}

export function isValidCidr(value: string): boolean {
  const idx = value.lastIndexOf('/')
  if (idx < 0) return false
  const addr = value.slice(0, idx)
  const prefixStr = value.slice(idx + 1)
  if (!/^\d{1,3}$/.test(prefixStr)) return false
  const prefix = Number(prefixStr)
  if (isValidIpv4(addr)) return prefix <= 32
  if (isValidIpv6(addr)) return prefix <= 128
  return false
}

/** RFC 1123-ish hostname/FQDN — labels of alnum/hyphen, no leading/trailing hyphen. */
const FQDN_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/
export function isValidFqdn(value: string): boolean {
  return FQDN_RE.test(value)
}

/** A bare alias-name-shaped token — used to (optimistically) accept a nested-alias reference. */
export function looksLikeAliasName(value: string): boolean {
  return NAME_CHARSET_RE.test(value) && value.length <= MAX_NAME_LENGTH && !ALL_DIGITS_RE.test(value)
}

/**
 * `is_port()` (src/etc/inc/util.inc): a bare numeric port 1-65535, OR a
 * service name resolvable via getservbyname() — this client cannot replicate
 * the live /etc/services lookup, so any alias-name-shaped token (which
 * subsumes short lowercase service names like "http") is accepted
 * optimistically; the REST API package is authoritative.
 */
export function isPortToken(value: string): boolean {
  if (/^\d{1,5}$/.test(value)) {
    const n = Number(value)
    return n >= 1 && n <= 65535
  }
  return looksLikeAliasName(value)
}

/** `is_portrange()` (src/etc/inc/util.inc): "<port>:<port>", COLON-delimited (not a hyphen). */
export function isPortRangeToken(value: string): boolean {
  const parts = value.split(':')
  return parts.length === 2 && parts.every(isPortToken)
}

/** Validate one `address` entry against the alias `type`, mirroring FirewallAlias::validate_address(). */
export function isValidAddressEntry(type: AliasType, value: string): boolean {
  if (!value) return false
  if (type === 'host') return isValidIp(value) || isValidFqdn(value) || looksLikeAliasName(value)
  if (type === 'network') return isValidCidr(value) || isValidFqdn(value) || looksLikeAliasName(value)
  if (type === 'port') return isPortToken(value) || isPortRangeToken(value)
  return false
}
