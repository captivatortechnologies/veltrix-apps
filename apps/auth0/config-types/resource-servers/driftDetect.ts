import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  getJson,
} from '../../lib/auth0Api'
import { readKeyValueMap, readOptionalInt, readString, stringMapsEqual } from '../../lib/fields'
import { findResourceServerByName, scopesToMap, type Auth0ResourceServer } from './_shared'

/**
 * Drift for Auth0 resource servers: compare the signing algorithm, token lifetime
 * and scopes we declare against the live API in Auth0 (matched by name). Only the
 * fields the operator sets are compared, so unset values never raise false drift.
 * Best-effort — an unmatched API is skipped. Read-only: mint token → GET /resource-servers.
 */
const LIST_FIELDS = 'id,name,identifier,scopes,signing_alg,token_lifetime'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let live: Auth0ResourceServer[]
  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const perPage = 100
    live = []
    for (let page = 0; page < 50; page++) {
      const url = `${base}/resource-servers?per_page=${perPage}&page=${page}&include_fields=true&fields=${encodeURIComponent(LIST_FIELDS)}`
      const batch = await getJson<Auth0ResourceServer[]>(url, accessToken)
      if (!Array.isArray(batch) || batch.length === 0) break
      live.push(...batch)
      if (batch.length < perPage) break
    }
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = readString(item.fields.name)
    const match = findResourceServerByName(live, name)
    if (!match) continue

    const expectedAlg = readString(item.fields.signing_alg)
    const actualAlg = String(match.signing_alg ?? '').trim()
    if (expectedAlg && actualAlg && expectedAlg !== actualAlg) {
      diffs.push({ field: `${name}.signing_alg`, expected: expectedAlg, actual: actualAlg, severity: 'warning' })
    }

    const expectedLifetime = readOptionalInt(item.fields.token_lifetime)
    if (expectedLifetime !== undefined && typeof match.token_lifetime === 'number' && expectedLifetime !== match.token_lifetime) {
      diffs.push({ field: `${name}.token_lifetime`, expected: expectedLifetime, actual: match.token_lifetime, severity: 'warning' })
    }

    const expectedScopes = readKeyValueMap(item.fields.scopes)
    if (Object.keys(expectedScopes).length > 0) {
      const actualScopes = scopesToMap(match.scopes)
      if (!stringMapsEqual(expectedScopes, actualScopes)) {
        diffs.push({
          field: `${name}.scopes`,
          expected: Object.keys(expectedScopes).sort(),
          actual: Object.keys(actualScopes).sort(),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
