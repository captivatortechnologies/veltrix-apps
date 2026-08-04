import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  listAllPages,
} from '../../lib/auth0Api'
import { readOptionalString, readString, readStringArray, stringSetsEqual } from '../../lib/fields'
import { findClientGrant, type Auth0ClientGrant } from './_shared'

/**
 * Drift for Auth0 client grants: compare the scope set, organization_usage and
 * allow_any_organization we declare against the live grant in Auth0 (matched
 * by the (client_id, audience) pair). Best-effort — an unmatched grant is
 * skipped. Read-only: mint token → GET /client-grants.
 */
const LIST_FIELDS = 'id,client_id,audience,scope,organization_usage,allow_any_organization'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let live: Auth0ClientGrant[]
  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    live = await listAllPages<Auth0ClientGrant>(
      (page) => `${base}/client-grants?per_page=100&page=${page}&include_fields=true&fields=${encodeURIComponent(LIST_FIELDS)}`,
      accessToken,
    )
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const clientId = readString(item.fields.client_id)
    const audience = readString(item.fields.audience)
    if (!clientId || !audience) continue

    const match = findClientGrant(live, clientId, audience)
    if (!match) continue

    const label = `${clientId}:${audience}`

    const expectedScope = readStringArray(item.fields.scope)
    const actualScope = Array.isArray(match.scope) ? match.scope : []
    if (!stringSetsEqual(expectedScope, actualScope)) {
      diffs.push({ field: `${label}.scope`, expected: expectedScope, actual: actualScope, severity: 'warning' })
    }

    const expectedOrgUsage = readOptionalString(item.fields.organization_usage)
    if (expectedOrgUsage !== undefined) {
      const actualOrgUsage = String(match.organization_usage ?? 'deny').trim() || 'deny'
      if (expectedOrgUsage !== actualOrgUsage) {
        diffs.push({ field: `${label}.organization_usage`, expected: expectedOrgUsage, actual: actualOrgUsage, severity: 'warning' })
      }
    }

    const expectedAllowAny = item.fields.allow_any_organization === true
    const actualAllowAny = match.allow_any_organization === true
    if (expectedAllowAny !== actualAllowAny) {
      diffs.push({ field: `${label}.allow_any_organization`, expected: expectedAllowAny, actual: actualAllowAny, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
