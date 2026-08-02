// =============================================================================
// Shared spec/validation/wire-format helpers for the OPNsense firewall-aliases
// config type. Kept in one file (not duplicated across deploy/rollback/drift)
// so a fix — e.g. a better host-entry matcher — lands everywhere at once.
//
// Scope of the `type` enum — verified against Alias.xml's OptionValues
// (github.com/opnsense/core, src/opnsense/mvc/app/models/OPNsense/Firewall/
// Alias.xml). Two of its 13 values are deliberately NOT offered here:
//   - "internal"  — reserved for aliases OPNsense itself creates (bogons,
//                   sshlockout, ...); never legitimately created by a client.
//   - "external"  — an advanced/read-only reference to an externally managed
//                   pf table; nothing for this app to author.
// One more is scoped OUT for this v0.1.0 release, flagged rather than faked:
//   - "authgroup" — content is a list of numeric OpenVPN GROUP IDs, resolved
//                   through AliasController::listUserGroupsAction(), which
//                   this app has no way to look up or validate against
//                   without also modeling OPNsense's local user-group system.
// The remaining 11 types are supported with their common field set (name,
// type, content, description, enabled, proto, interface, updatefreq).
// Two further REAL model fields are dropped, also flagged rather than faked:
//   - `username`/`password`/`authtype` — authenticated URL-table credentials.
//     Storing a fetch password inside a canvas configuration is a bad
//     practice this codebase avoids elsewhere; a future credential-backed
//     extension is the right home for it.
//   - `expire` / `categories` — a dynamic-host TTL and a relation to Firewall
//     Category objects, which would need their own config type/lookup first.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { AliasBody, LiveAlias } from '../../lib/opnsenseApi'

export const ALIAS_TYPES = [
  { value: 'host', label: 'Host(s)' },
  { value: 'network', label: 'Network(s)' },
  { value: 'port', label: 'Port(s)' },
  { value: 'url', label: 'URL (IPs)' },
  { value: 'urltable', label: 'URL Table (IPs)' },
  { value: 'urljson', label: 'URL Table in JSON format (IPs)' },
  { value: 'geoip', label: 'GeoIP' },
  { value: 'networkgroup', label: 'Network group' },
  { value: 'mac', label: 'MAC address' },
  { value: 'asn', label: 'BGP ASN' },
  { value: 'dynipv6host', label: 'Dynamic IPv6 Host' },
] as const

export type AliasType = (typeof ALIAS_TYPES)[number]['value']
const ALIAS_TYPE_VALUES = new Set<string>(ALIAS_TYPES.map((t) => t.value))

export function isSupportedAliasType(value: string): value is AliasType {
  return ALIAS_TYPE_VALUES.has(value)
}

/** Types whose entries need a URL-table refresh cadence (`updatefreq`). */
export const URL_TABLE_TYPES = new Set<string>(['url', 'urltable', 'urljson'])

// --- Shared value parsing ------------------------------------------------------

/** Read a canvas value that may be a `tags`/`multiselect` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

/**
 * An alias's logical identity: its exact `name`, trimmed only. OPNsense's own
 * uniqueness constraint (Alias.xml `check001`, type UniqueConstraint) and its
 * reserved-word check (AliasNameField::getValidators, plain PHP
 * `in_array($value, $reservedwords)`) are both case-SENSITIVE string
 * comparisons, so this does not lower-case the way this codebase's
 * case-insensitive tools (e.g. Check Point host names) do.
 */
export function aliasKey(name: string): string {
  return name.trim()
}

// --- Spec extraction shared by validate / deploy / rollback / drift / health ---

export interface AliasSpec {
  itemId?: string
  name: string
  type: string
  enabled: boolean
  description: string
  content: string[]
  proto: string[]
  interface: string
  updatefreq: number | null
}

export function extractAliasSpecs(canvas: CanvasSnapshot): AliasSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: asString(f.type) || 'host',
      enabled: f.enabled !== false,
      description: asString(f.description),
      content: strList(f.content),
      proto: strList(f.proto),
      interface: asString(f.interface),
      updatefreq: asNumberOrNull(f.updatefreq),
    }
  })
}

// --- Wire format ---------------------------------------------------------------

/**
 * Build the addItem/setItem `alias` body for a declared spec. Every field is
 * ALWAYS included (never conditionally omitted) so that clearing a field in
 * the canvas genuinely clears it on OPNsense too — setItem only overwrites
 * the keys present in the body (see lib/opnsenseApi.ts's AliasBody doc).
 */
export function buildAliasBody(spec: AliasSpec): AliasBody {
  return {
    enabled: spec.enabled ? '1' : '0',
    name: spec.name,
    type: spec.type,
    content: spec.content.join('\n'),
    description: spec.description,
    proto: spec.proto.join(','),
    interface: spec.interface,
    updatefreq: spec.updatefreq != null ? String(spec.updatefreq) : '',
  }
}

/**
 * Snapshot a live alias (as returned by searchItem) into a setItem-ready
 * body, for rollback restoration. searchItem rows are already the same flat
 * string shape addItem/setItem write, so this is a straight field carry-over.
 */
export function snapshotLive(live: LiveAlias): AliasBody {
  return {
    enabled: String(live.enabled ?? '1'),
    name: String(live.name ?? ''),
    type: String(live.type ?? 'host'),
    content: String(live.content ?? ''),
    description: String(live.description ?? ''),
    proto: String(live.proto ?? ''),
    interface: String(live.interface ?? ''),
    updatefreq: String(live.updatefreq ?? ''),
  }
}

/** Split a live alias's raw `\n`-joined content back into entries, dropping blank lines. */
export function liveContentList(live: LiveAlias): string[] {
  return String(live.content ?? '')
    .split('\n')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}

/** Case-sensitive, order-insensitive set equality for two entry lists. */
export function sameEntrySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((v) => setA.has(v))
}

// --- Format validators, ported from AliasContentField's own switch ------------
// (github.com/opnsense/core, src/opnsense/mvc/app/models/OPNsense/Firewall/
// FieldTypes/AliasContentField.php) so the canvas rejects the same shapes the
// server would, before a deploy round-trip. Country-code and reserved-service
// checks that need OPNsense's own data files (tzdata, /etc/services) are
// intentionally left to the server's own validation response — see README.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
export function isValidIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

// Pragmatic (not exhaustively RFC 4291-complete) IPv6 matcher: full and
// zero-compressed ("::") forms, including an embedded IPv4 tail and zone id.
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))$/
export function isValidIpv6(value: string): boolean {
  return IPV6_RE.test(value)
}

export function isIpAddress(value: string): boolean {
  return isValidIpv4(value) || isValidIpv6(value)
}

/** `ip/prefixlen`, e.g. "10.0.0.0/24" or "2001:db8::/32". */
export function isCidr(value: string): boolean {
  const parts = value.split('/')
  if (parts.length !== 2 || !/^\d{1,3}$/.test(parts[1])) return false
  const prefix = Number(parts[1])
  if (isValidIpv4(parts[0])) return prefix <= 32
  if (isValidIpv6(parts[0])) return prefix <= 128
  return false
}

const HOSTNAME_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/
export function isHostname(value: string): boolean {
  return value.length <= 253 && HOSTNAME_RE.test(value)
}

// Same regex OPNsense's own AliasNameField uses to accept/reject an alias
// name — reused here so a `networkgroup`/nested-alias-reference entry, or a
// bare alias name used inside a host/network/port list, is judged the same way.
const ALIAS_NAME_RE = /^([a-zA-Z]|(([_a-zA-Z][a-zA-Z0-9]|[a-zA-Z][_a-zA-Z0-9])[_a-zA-Z0-9]{0,29}))$/
export function looksLikeAliasName(value: string): boolean {
  return ALIAS_NAME_RE.test(value)
}

/** host-type entry: IP/hostname/alias-ref, an address range ("a-b"), or a "!"-excluded one. */
export function isValidHostEntry(value: string): boolean {
  const v = value.startsWith('!') ? value.slice(1) : value
  if (v.includes('-')) {
    const [a, b] = v.split('-', 2)
    if (isIpAddress(a) && isIpAddress(b)) return true
  }
  return isIpAddress(v) || isHostname(v) || looksLikeAliasName(v)
}

/** network-type entry: CIDR, a bare IP, an address range, or an alias reference. */
export function isValidNetworkEntry(value: string): boolean {
  const v = value.startsWith('!') ? value.slice(1) : value
  if (v.includes('-')) {
    const [a, b] = v.split('-', 2)
    if (isIpAddress(a) && isIpAddress(b)) return true
  }
  return isCidr(v) || isIpAddress(v) || looksLikeAliasName(v)
}

/** port-type entry: a single port, a "start-end" range, or an alias reference. */
export function isValidPortEntry(value: string): boolean {
  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535
  if (value.includes('-')) {
    const [a, b] = value.split('-', 2)
    if (/^\d+$/.test(a) && /^\d+$/.test(b) && inRange(Number(a)) && inRange(Number(b))) return true
  }
  if (/^\d+$/.test(value) && inRange(Number(value))) return true
  return looksLikeAliasName(value)
}

/** MAC-type entry: a full or PARTIAL (1-5 octet) MAC address. */
export function isValidMacEntry(value: string): boolean {
  return /^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){1,5}$/.test(value)
}

/** ASN-type entry: an integer in pf's accepted BGP ASN range. */
export function isValidAsnEntry(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) < 4294967296
}

/** GeoIP-type entry: a 2-letter ISO country code, or the "EU" (unclassified) pseudo-code. */
export function isValidGeoipEntry(value: string): boolean {
  return value === 'EU' || /^[A-Z]{2}$/.test(value)
}

/** networkgroup-type entry: must itself be a valid alias name (a nested alias reference). */
export function isValidNetworkGroupEntry(value: string): boolean {
  return looksLikeAliasName(value)
}

/**
 * Partial-IPv6 form for a Dynamic IPv6 Host entry, e.g. "::1000" — ported
 * directly from AliasContentField::validatePartialIPv6Network(), which
 * checks `Util::isIpAddress("0000" . $pnetwork)`: prefixing a literal "0000"
 * turns a valid partial suffix into a normal, fully-parseable IPv6 address.
 */
export function isValidPartialIpv6Entry(value: string): boolean {
  return isValidIpv6(`0000${value}`)
}

/**
 * Validate one content entry against its alias `type`. Returns an error
 * message, or null when the entry is acceptable. `url`/`urltable`/`urljson`
 * entries are intentionally NOT format-checked — AliasContentField.php's own
 * validator switch has no case for them either, so any non-empty string is
 * left to OPNsense's own fetch to accept or reject.
 */
export function validateContentEntry(type: string, entry: string): string | null {
  switch (type) {
    case 'host':
      return isValidHostEntry(entry) ? null : `"${entry}" is not a valid hostname, IP address, range, or alias reference`
    case 'network':
      return isValidNetworkEntry(entry) ? null : `"${entry}" is not a valid network, IP address, range, or alias reference`
    case 'port':
      return isValidPortEntry(entry) ? null : `"${entry}" is not a valid port, port range, or alias reference`
    case 'mac':
      return isValidMacEntry(entry) ? null : `"${entry}" is not a valid (partial) MAC address`
    case 'asn':
      return isValidAsnEntry(entry) ? null : `"${entry}" is not a valid ASN`
    case 'geoip':
      return isValidGeoipEntry(entry) ? null : `"${entry}" is not a valid 2-letter country code`
    case 'networkgroup':
      return isValidNetworkGroupEntry(entry) ? null : `"${entry}" is not a valid alias name`
    case 'dynipv6host':
      return isValidPartialIpv6Entry(entry) ? null : `"${entry}" is not a valid partial IPv6 address (e.g. ::1000)`
    default:
      return null
  }
}
