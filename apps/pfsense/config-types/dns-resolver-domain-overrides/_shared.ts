// =============================================================================
// Shared helpers for the DNS Resolver Domain Overrides config type (validate
// + deploy + rollback + drift). Field shapes verified against
// RESTAPI/Models/DNSResolverDomainOverride.inc.
//
// IDENTITY: the Model does not declare `unique: true` on `domain`, but
// pfSense's own GUI only ever shows/allows one domain override per domain in
// practice — this app uses `domain` (lowercased, trimmed) as its identity
// key, the same name-keyed pattern as firewall-aliases.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import { isValidFqdn, isValidIp } from '../lib/pfsenseShared'
import type { DnsResolverDomainOverride } from '../../lib/pfsenseApi'

export const MAX_DESCRIPTION_LENGTH = 1024

export interface DomainOverrideSpec {
  itemId?: string
  domain: string
  ip: string
  descr: string
  forwardTlsUpstream: boolean
  tlsHostname: string
}

export function specFromItem(item: CanvasItemSnapshot): DomainOverrideSpec {
  const f = item.fields ?? {}
  return {
    itemId: item.id,
    domain: String(f.domain ?? '').trim(),
    ip: String(f.ip ?? '').trim(),
    descr: String(f.descr ?? '').trim(),
    forwardTlsUpstream: f.forward_tls_upstream === true,
    tlsHostname: String(f.tls_hostname ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): DomainOverrideSpec[] {
  return items.map(specFromItem)
}

/** Domain-override identity — lowercased, trimmed (domains are case-insensitive, unlike pfSense alias names). */
export function domainOverrideKey(domain: string): string {
  return domain.trim().toLowerCase()
}

/** A domain override's `domain` accepts a hostname, a bare domain, or an FQDN — all validated the same way here. */
export function isValidOverrideDomain(value: string): boolean {
  return isValidFqdn(value) || /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value)
}

export function toDomainOverrideBody(spec: DomainOverrideSpec): Omit<DnsResolverDomainOverride, 'id'> {
  return {
    domain: spec.domain,
    ip: spec.ip,
    descr: spec.descr,
    forward_tls_upstream: spec.forwardTlsUpstream,
    tls_hostname: spec.forwardTlsUpstream ? spec.tlsHostname : '',
  }
}

export function snapshotDomainOverride(live: DnsResolverDomainOverride): Omit<DnsResolverDomainOverride, 'id'> {
  return {
    domain: live.domain,
    ip: live.ip,
    descr: live.descr ?? '',
    forward_tls_upstream: live.forward_tls_upstream ?? false,
    tls_hostname: live.tls_hostname ?? '',
  }
}

export { isValidIp }
