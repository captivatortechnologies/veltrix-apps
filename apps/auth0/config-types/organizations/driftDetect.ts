import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, listAllPages } from '../../lib/auth0Api'
import { readString, stringMapsEqual } from '../../lib/fields'
import { findOrganizationByName, parseEnabledConnections, sameEnabledConnection, type Auth0Organization } from './_shared'
import { getEnabledConnections } from './connections'

/**
 * Drift for Auth0 organizations: compare display name, metadata, third-party
 * client access and enabled connections we declare against the live organization
 * in Auth0 (matched by name). Best-effort — an unmatched organization is skipped.
 * Read-only: mint token → GET /organizations (+ /organizations/{id}/enabled_connections).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let live: Auth0Organization[]
  let accessToken: string
  try {
    accessToken = (await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })).accessToken
    live = await listAllPages<Auth0Organization>((page) => `${base}/organizations?per_page=100&page=${page}`, accessToken)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = readString(item.fields.name)
    const match = findOrganizationByName(live, name)
    if (!match || !match.id) continue

    const expectedDisplay = readString(item.fields.display_name)
    const actualDisplay = String(match.display_name ?? '')
    if (expectedDisplay !== actualDisplay) {
      diffs.push({ field: `${name}.display_name`, expected: expectedDisplay, actual: actualDisplay, severity: 'warning' })
    }

    const expectedAccess = readString(item.fields.third_party_client_access)
    const actualAccess = String(match.third_party_client_access ?? '')
    if (expectedAccess && actualAccess && expectedAccess !== actualAccess) {
      diffs.push({ field: `${name}.third_party_client_access`, expected: expectedAccess, actual: actualAccess, severity: 'warning' })
    }

    const rawMetadata = item.fields.metadata
    if (rawMetadata && typeof rawMetadata === 'object') {
      const expectedMetadata: Record<string, string> = {}
      for (const [k, v] of Object.entries(rawMetadata as Record<string, unknown>)) expectedMetadata[k] = String(v ?? '')
      const actualMetadata = match.metadata ?? {}
      if (!stringMapsEqual(expectedMetadata, actualMetadata)) {
        diffs.push({ field: `${name}.metadata`, expected: expectedMetadata, actual: actualMetadata, severity: 'warning' })
      }
    }

    let liveConnections: Awaited<ReturnType<typeof getEnabledConnections>>
    try {
      liveConnections = await getEnabledConnections(base, match.id, accessToken)
    } catch {
      continue
    }
    const desiredConnections = parseEnabledConnections(item.fields.enabled_connections)
    const liveById = new Map(liveConnections.map((c) => [c.connectionId, c]))
    for (const desired of desiredConnections) {
      const actual = liveById.get(desired.connectionId)
      if (!actual) {
        diffs.push({ field: `${name}.enabled_connections.${desired.connectionId}`, expected: 'enabled', actual: 'missing', severity: 'warning' })
      } else if (!sameEnabledConnection(desired, actual)) {
        diffs.push({
          field: `${name}.enabled_connections.${desired.connectionId}`,
          expected: JSON.stringify(desired),
          actual: JSON.stringify(actual),
          severity: 'warning',
        })
      }
    }
    const desiredIds = new Set(desiredConnections.map((d) => d.connectionId))
    for (const actual of liveConnections) {
      if (!desiredIds.has(actual.connectionId)) {
        diffs.push({ field: `${name}.enabled_connections.${actual.connectionId}`, expected: 'absent', actual: 'enabled', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
