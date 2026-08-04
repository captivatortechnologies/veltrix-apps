// =============================================================================
// Shared helpers for the DNS Resolver Host Overrides config type (validate +
// deploy + rollback + drift). Field shapes verified against
// RESTAPI/Models/DNSResolverHostOverride.inc — see lib/pfsenseApi.ts's
// module doc for the composite-identity and dropped-`aliases` citations.
//
// IDENTITY: `host`+`domain` together are `unique_together_fields` (a
// COMPOSITE key, verified) — this app uses `${host}.${domain}` (lowercased,
// trimmed) as its identity key.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import { isValidIp } from '../lib/pfsenseShared'
import type { DnsResolverHostOverride } from '../../lib/pfsenseApi'

export const MAX_DESCRIPTION_LENGTH = 1024
const HOSTNAME_LABEL_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/
const DOMAIN_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return []
}

export interface HostOverrideSpec {
  itemId?: string
  /** May be blank to override the bare domain itself (verified: `allow_empty: true`). */
  host: string
  domain: string
  ip: string[]
  descr: string
}

export function specFromItem(item: CanvasItemSnapshot): HostOverrideSpec {
  const f = item.fields ?? {}
  return {
    itemId: item.id,
    host: String(f.host ?? '').trim(),
    domain: String(f.domain ?? '').trim(),
    ip: strList(f.ip),
    descr: String(f.descr ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): HostOverrideSpec[] {
  return items.map(specFromItem)
}

/** Composite host+domain identity — lowercased, trimmed (DNS names are case-insensitive). */
export function hostOverrideKey(host: string, domain: string): string {
  return `${host.trim().toLowerCase()}.${domain.trim().toLowerCase()}`
}

export function isValidHostLabel(value: string): boolean {
  return value === '' || HOSTNAME_LABEL_RE.test(value)
}

export function isValidOverrideDomain(value: string): boolean {
  return DOMAIN_RE.test(value)
}

/** `aliases` is always sent as an empty array — this app does not support authoring nested alias hostnames in v0.3.0, see this file's module doc. */
export function toHostOverrideBody(spec: HostOverrideSpec): Omit<DnsResolverHostOverride, 'id'> {
  return { host: spec.host, domain: spec.domain, ip: spec.ip, descr: spec.descr, aliases: [] }
}

export function snapshotHostOverride(live: DnsResolverHostOverride): Omit<DnsResolverHostOverride, 'id'> {
  return {
    host: live.host,
    domain: live.domain,
    ip: Array.isArray(live.ip) ? live.ip : [],
    descr: live.descr ?? '',
    aliases: Array.isArray(live.aliases) ? live.aliases : [],
  }
}

export { isValidIp }
