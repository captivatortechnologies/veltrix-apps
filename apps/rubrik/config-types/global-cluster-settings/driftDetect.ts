import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, resolveServiceAccount } from '../../lib/rubrikApi'
import {
  buildClusterSettingsSpec,
  ntpServersFrom,
  stringListFrom,
  stringListsEqual,
  type LoginBannerResponse,
  type RubrikClusterInfo,
} from './_shared'

/**
 * Drift for Global Cluster Settings: compare each of the five declared areas
 * (identity, DNS nameservers, DNS search domains, NTP servers, login banner)
 * against the cluster's live values. Each area is checked independently and
 * best-effort — a read failure for one area is skipped rather than raising a
 * false positive or aborting the others. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveServiceAccount(credential)) return { hasDrift: false, diffs }
  if (items.length === 0) return { hasDrift: false, diffs }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch {
    return { hasDrift: false, diffs }
  }

  const spec = buildClusterSettingsSpec(items[0].fields)

  try {
    const info = await getJson<RubrikClusterInfo>(conn, '/api/v1/cluster/me')
    const actualName = info.name ?? ''
    if (spec.clusterName && spec.clusterName !== actualName) {
      diffs.push({ field: 'clusterName', expected: spec.clusterName, actual: actualName, severity: 'warning' })
    }
    const actualTz = info.timezone?.timezone ?? ''
    if (spec.timezone !== actualTz) {
      diffs.push({ field: 'timezone', expected: spec.timezone, actual: actualTz, severity: 'warning' })
    }
    const actualLocation = info.geolocation?.address ?? ''
    if (spec.location !== actualLocation) {
      diffs.push({ field: 'location', expected: spec.location || '(empty)', actual: actualLocation || '(empty)', severity: 'info' })
    }
  } catch {
    // best-effort: skip this area rather than assert drift on a transient error
  }

  try {
    const dnsServers = stringListFrom(await getJson<unknown>(conn, '/api/internal/cluster/me/dns_nameserver'))
    if (!stringListsEqual(dnsServers, spec.dnsServers)) {
      diffs.push({
        field: 'dnsServers',
        expected: spec.dnsServers.join(', ') || '(empty)',
        actual: dnsServers.join(', ') || '(empty)',
        severity: 'warning',
      })
    }
  } catch {
    // best-effort
  }

  try {
    const dnsSearchDomains = stringListFrom(await getJson<unknown>(conn, '/api/internal/cluster/me/dns_search_domain'))
    if (!stringListsEqual(dnsSearchDomains, spec.dnsSearchDomains)) {
      diffs.push({
        field: 'dnsSearchDomains',
        expected: spec.dnsSearchDomains.join(', ') || '(empty)',
        actual: dnsSearchDomains.join(', ') || '(empty)',
        severity: 'info',
      })
    }
  } catch {
    // best-effort
  }

  try {
    const ntpServers = ntpServersFrom(await getJson<unknown>(conn, '/api/internal/cluster/me/ntp_server'))
    if (!stringListsEqual(ntpServers, spec.ntpServers)) {
      diffs.push({
        field: 'ntpServers',
        expected: spec.ntpServers.join(', ') || '(empty)',
        actual: ntpServers.join(', ') || '(empty)',
        severity: 'warning',
      })
    }
  } catch {
    // best-effort
  }

  try {
    const banner = await getJson<LoginBannerResponse>(conn, '/api/internal/cluster/me/login_banner')
    const actualBanner = banner.loginBanner ?? ''
    if (actualBanner !== spec.loginBanner) {
      diffs.push({
        field: 'loginBanner',
        expected: spec.loginBanner || '(empty)',
        actual: actualBanner || '(empty)',
        severity: 'info',
      })
    }
  } catch {
    // best-effort
  }

  return { hasDrift: diffs.length > 0, diffs }
}
