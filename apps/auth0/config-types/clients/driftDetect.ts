import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  getJson,
} from '../../lib/auth0Api'
import { findClientByName, parseList, sameUrlList, type Auth0Client } from './_shared'

/**
 * Drift for Auth0 clients: compare the application type, URL lists and token
 * endpoint auth method we declare against the live client in Auth0 (matched by
 * name). Best-effort — a client that can't be matched (missing / transient error)
 * is skipped rather than raising false drift. Read-only: mint token → GET /clients.
 */
const LIST_FIELDS =
  'client_id,name,app_type,callbacks,allowed_logout_urls,web_origins,token_endpoint_auth_method'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let live: Auth0Client[]
  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const perPage = 100
    live = []
    for (let page = 0; page < 50; page++) {
      const url = `${base}/clients?per_page=${perPage}&page=${page}&include_fields=true&fields=${encodeURIComponent(LIST_FIELDS)}`
      const batch = await getJson<Auth0Client[]>(url, accessToken)
      if (!Array.isArray(batch) || batch.length === 0) break
      live.push(...batch)
      if (batch.length < perPage) break
    }
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read clients, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findClientByName(live, name)
    if (!match) continue

    const expectedAppType = String(item.fields.app_type ?? '').trim()
    const actualAppType = String(match.app_type ?? '').trim()
    if (expectedAppType && actualAppType && expectedAppType !== actualAppType) {
      diffs.push({ field: `${name}.app_type`, expected: expectedAppType, actual: actualAppType, severity: 'warning' })
    }

    const expectedTokenAuth = String(item.fields.token_endpoint_auth_method ?? '').trim()
    const actualTokenAuth = String(match.token_endpoint_auth_method ?? '').trim()
    if (expectedTokenAuth && actualTokenAuth && expectedTokenAuth !== actualTokenAuth) {
      diffs.push({ field: `${name}.token_endpoint_auth_method`, expected: expectedTokenAuth, actual: actualTokenAuth, severity: 'warning' })
    }

    for (const key of ['callbacks', 'allowed_logout_urls', 'web_origins'] as const) {
      if (!sameUrlList(item.fields[key], match[key])) {
        diffs.push({
          field: `${name}.${key}`,
          expected: parseList(item.fields[key]),
          actual: parseList(match[key]),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
