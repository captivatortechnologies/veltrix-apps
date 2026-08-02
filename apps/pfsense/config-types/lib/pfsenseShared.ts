// =============================================================================
// Shared low-level validation primitives reused across every pfSense config
// type (firewall-aliases, firewall-rules, nat-port-forwards, virtual-ips).
// Kept here — not duplicated per config type — so a fix (e.g. a better IPv6
// matcher) lands everywhere at once, mirroring this codebase's Check Point
// `config-types/lib/checkpointShared.ts`.
//
// Every schema-only check here is a client-side, BEST-EFFORT mirror of a rule
// verified in the pfSense REST API package's PHP source (cited per function);
// none of it calls the live API (see each config type's own module doc for
// why — validate handlers run before a connection/credential may even
// exist). The REST API package remains the final authority.
// =============================================================================

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
export function isValidIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

// A pragmatic (not exhaustively RFC 4291) IPv6 matcher — full and "::"-compressed forms.
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

const GENERIC_TOKEN_CHARSET_RE = /^[A-Za-z0-9_]+$/
const ALL_DIGITS_RE = /^\d+$/

/** A bare alnum/underscore token shape — used to optimistically accept an alias/interface-name reference this client cannot verify live. */
export function looksLikeToken(value: string, maxLength = 31): boolean {
  return GENERIC_TOKEN_CHARSET_RE.test(value) && value.length <= maxLength && !ALL_DIGITS_RE.test(value)
}

/**
 * `is_port()` (pfSense src/etc/inc/util.inc): a bare numeric port 1-65535, OR
 * a service name resolvable via getservbyname() — this client cannot
 * replicate the live /etc/services lookup, so any token-shaped value (which
 * subsumes short lowercase service names like "http") is accepted
 * optimistically; the REST API package is authoritative.
 */
export function isPortToken(value: string): boolean {
  if (/^\d{1,5}$/.test(value)) {
    const n = Number(value)
    return n >= 1 && n <= 65535
  }
  return looksLikeToken(value)
}

/** `is_portrange()` (pfSense src/etc/inc/util.inc): "<port>:<port>", COLON-delimited (not a hyphen). */
export function isPortRangeToken(value: string): boolean {
  const parts = value.split(':')
  return parts.length === 2 && parts.every(isPortToken)
}

/**
 * A pfSense "filter address" value (firewall/NAT rule source or
 * destination) — verified against RESTAPI/Fields/FilterAddressField.inc's
 * `validate_extra()`: an IP address, a subnet CIDR, an existing alias, the
 * literal `any`, `(self)`, `l2tp`, `pppoe`, or an interface name (optionally
 * suffixed `:ip` to mean that interface's current address) — any of the
 * above (except `any` itself) may be prefixed with `!` to invert. `!any` is
 * explicitly rejected by the field itself (verified) and is rejected here
 * too.
 */
export function isValidFilterAddress(value: string): boolean {
  if (!value) return false
  const hasInvert = value.startsWith('!')
  const base = hasInvert ? value.slice(1) : value
  if (!base) return false
  if (base === 'any') return !hasInvert
  if (base === '(self)' || base === 'l2tp' || base === 'pppoe') return true
  if (isValidIp(base) || isValidCidr(base)) return true
  const withoutIpSuffix = base.endsWith(':ip') ? base.slice(0, -3) : base
  return looksLikeToken(withoutIpSuffix, 64)
}

/**
 * A pfSense NAT port-forward `target` value — verified against
 * PortForward.inc's SpecialNetworkField configuration, which is
 * DELIBERATELY more restrictive than a filter address: only an IP address,
 * an existing alias, or an interface's `:ip` modifier — no bare interface
 * name, no subnet, no `any`/`(self)`/`l2tp`/`pppoe` (all disabled:
 * `allow_any/allow_self/allow_l2tp/allow_pppoe: false`), no `!` invert.
 *
 * A bare token (e.g. "wan") is ACCEPTED optimistically — it may be an
 * existing alias, which this schema-only check cannot distinguish from an
 * interface name by shape alone (both are plain alnum/underscore tokens);
 * the REST API package is authoritative. The four literal special
 * keywords ARE rejected outright even though they share that same generic
 * token shape, because typing one as a NAT target is overwhelmingly more
 * likely to be a mistake (carried over from a firewall-rule's source/
 * destination field, where they ARE valid) than an actual alias coincidentally
 * named "any"/"l2tp"/"pppoe" — a real edge case this client-side check
 * knowingly does not support; verify against a live target before assuming
 * otherwise.
 */
export function isValidNatTarget(value: string): boolean {
  if (!value) return false
  if (isValidIp(value)) return true
  if (['any', '(self)', 'l2tp', 'pppoe'].includes(value)) return false
  if (value.endsWith(':ip')) return looksLikeToken(value.slice(0, -3), 64)
  return looksLikeToken(value)
}

/** A pfSense interface/interface-group value — format-only; existence is verified server-side. `any` is a valid literal on floating firewall rules. */
export function looksLikeInterfaceToken(value: string): boolean {
  return value === 'any' || looksLikeToken(value, 64)
}
