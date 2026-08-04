import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  getJson,
} from '../../lib/auth0Api'
import { readKeyValueMap, readOptionalString, readString, stringMapsEqual } from '../../lib/fields'
import { findCustomDomainByDomain, type Auth0CustomDomain } from './_shared'

/**
 * Drift for Auth0 custom domains: compare the TLS policy, custom client-IP
 * header and domain metadata we declare against the live domain in Auth0
 * (matched by domain). Only the fields the operator sets are compared, so
 * unset values never raise false drift. Best-effort — an unmatched domain is
 * skipped. Read-only: mint token → GET /custom-domains (not paginated, unlike
 * every other list endpoint in this app).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domainHost = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domainHost)

  let live: Auth0CustomDomain[]
  try {
    const { accessToken } = await fetchManagementToken({ domain: domainHost, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const list = await getJson<Auth0CustomDomain[]>(`${base}/custom-domains`, accessToken)
    live = Array.isArray(list) ? list : []
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const domain = readString(item.fields.domain)
    const match = findCustomDomainByDomain(live, domain)
    if (!match) continue

    const expectedTlsPolicy = readOptionalString(item.fields.tls_policy)
    if (expectedTlsPolicy !== undefined) {
      const actualTlsPolicy = String(match.tls_policy ?? '').trim()
      if (expectedTlsPolicy !== actualTlsPolicy) {
        diffs.push({ field: `${domain}.tls_policy`, expected: expectedTlsPolicy, actual: actualTlsPolicy, severity: 'warning' })
      }
    }

    const expectedIpHeader = readOptionalString(item.fields.custom_client_ip_header)
    if (expectedIpHeader !== undefined) {
      const actualIpHeader = String(match.custom_client_ip_header ?? '').trim()
      if (expectedIpHeader !== actualIpHeader) {
        diffs.push({ field: `${domain}.custom_client_ip_header`, expected: expectedIpHeader, actual: actualIpHeader, severity: 'warning' })
      }
    }

    const expectedMetadata = readKeyValueMap(item.fields.domain_metadata)
    if (Object.keys(expectedMetadata).length > 0) {
      const actualMetadata = (match.domain_metadata ?? {}) as Record<string, string>
      if (!stringMapsEqual(expectedMetadata, actualMetadata)) {
        diffs.push({
          field: `${domain}.domain_metadata`,
          expected: Object.keys(expectedMetadata).sort(),
          actual: Object.keys(actualMetadata).sort(),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
