import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  getJson,
} from '../../lib/auth0Api'
import { parseJsonObject, readOptionalString, readStringArray, readString, stringSetsEqual } from '../../lib/fields'
import { findConnectionByName, nonSecretOptions, type Auth0Connection } from './_shared'

/**
 * Drift for Auth0 connections: compare the display name, enabled clients and the
 * declared (non-secret) option keys we author against the live connection in Auth0
 * (matched by name). Only DECLARED option keys are compared, so server-side option
 * defaults never raise false drift; secret-bearing option keys are ignored because
 * Auth0 returns them masked. Best-effort — an unmatched connection is skipped.
 * Read-only: mint token → GET /connections.
 */
const LIST_FIELDS = 'id,name,strategy,display_name,enabled_clients,options'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let live: Auth0Connection[]
  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const perPage = 100
    live = []
    for (let page = 0; page < 50; page++) {
      const url = `${base}/connections?per_page=${perPage}&page=${page}&include_fields=true&fields=${encodeURIComponent(LIST_FIELDS)}`
      const batch = await getJson<Auth0Connection[]>(url, accessToken)
      if (!Array.isArray(batch) || batch.length === 0) break
      live.push(...batch)
      if (batch.length < perPage) break
    }
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = readString(item.fields.name)
    const match = findConnectionByName(live, name)
    if (!match) continue

    const expectedStrategy = readString(item.fields.strategy)
    const actualStrategy = String(match.strategy ?? '').trim()
    if (expectedStrategy && actualStrategy && expectedStrategy !== actualStrategy) {
      diffs.push({ field: `${name}.strategy`, expected: expectedStrategy, actual: actualStrategy, severity: 'warning' })
    }

    const expectedDisplay = readOptionalString(item.fields.display_name)
    if (expectedDisplay !== undefined) {
      const actualDisplay = typeof match.display_name === 'string' ? match.display_name : ''
      if (expectedDisplay !== actualDisplay) {
        diffs.push({ field: `${name}.display_name`, expected: expectedDisplay, actual: actualDisplay, severity: 'warning' })
      }
    }

    const expectedClients = readStringArray(item.fields.enabled_clients)
    if (expectedClients.length > 0) {
      const actualClients = Array.isArray(match.enabled_clients) ? match.enabled_clients : []
      if (!stringSetsEqual(expectedClients, actualClients)) {
        diffs.push({ field: `${name}.enabled_clients`, expected: expectedClients, actual: actualClients, severity: 'warning' })
      }
    }

    const parsed = parseJsonObject(item.fields.options)
    if (parsed.ok) {
      const declared = nonSecretOptions(parsed.value)
      const liveOptions = (match.options ?? {}) as Record<string, unknown>
      for (const [key, value] of Object.entries(declared)) {
        const expected = JSON.stringify(value)
        const actual = JSON.stringify(liveOptions[key])
        if (expected !== actual) {
          diffs.push({ field: `${name}.options.${key}`, expected, actual, severity: 'warning' })
        }
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
