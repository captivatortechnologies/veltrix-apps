import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { auth0Fetch, bearer, resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials } from '../../lib/auth0Api'
import { parseJsonObject, readString, stripSecretKeys } from '../../lib/fields'
import { EMAIL_PROVIDER_PATH, type Auth0EmailProvider } from './_shared'

/**
 * Drift for the Auth0 Email Provider: GET /emails/provider; a 404 means no
 * provider exists yet, so there is nothing to compare against (best-effort —
 * no drift asserted, not a failure). Compares name, enabled,
 * default_from_address, settings (per-key JSON compare, like connections'
 * `options`) and non-secret credential keys only — secret-bearing credential
 * values are never returned by Auth0, so they are excluded from comparison
 * entirely.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  const diffs: DriftDiff[] = []
  if (!item) return { hasDrift: false, diffs }

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let live: Auth0EmailProvider
  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const res = await auth0Fetch(`${base}/${EMAIL_PROVIDER_PATH}`, { headers: bearer(accessToken) })
    if (res.status === 404) return { hasDrift: false, diffs }
    if (!res.ok) return { hasDrift: false, diffs }
    live = JSON.parse(res.body || '{}') as Auth0EmailProvider
  } catch {
    return { hasDrift: false, diffs }
  }

  const expectedName = readString(item.fields.name)
  const actualName = typeof live.name === 'string' ? live.name : ''
  if (expectedName !== actualName) {
    diffs.push({ field: 'name', expected: expectedName, actual: actualName, severity: 'warning' })
  }

  const expectedEnabled = item.fields.enabled === true || item.fields.enabled === 'true'
  const actualEnabled = live.enabled === true
  if (expectedEnabled !== actualEnabled) {
    diffs.push({ field: 'enabled', expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
  }

  const expectedFrom = readString(item.fields.default_from_address)
  const actualFrom = typeof live.default_from_address === 'string' ? live.default_from_address : ''
  if (expectedFrom !== actualFrom) {
    diffs.push({ field: 'default_from_address', expected: expectedFrom, actual: actualFrom, severity: 'warning' })
  }

  const settings = parseJsonObject(item.fields.settings)
  if (settings.ok) {
    const liveSettings = (live.settings ?? {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(settings.value)) {
      const expected = JSON.stringify(value)
      const actual = JSON.stringify(liveSettings[key])
      if (expected !== actual) {
        diffs.push({ field: `settings.${key}`, expected, actual, severity: 'warning' })
      }
    }
  }

  const credentials = parseJsonObject(item.fields.credentials)
  if (credentials.ok) {
    const declaredNonSecret = stripSecretKeys(credentials.value)
    const liveNonSecretCredentials = stripSecretKeys((live.credentials ?? {}) as Record<string, unknown>)
    for (const [key, value] of Object.entries(declaredNonSecret)) {
      const expected = JSON.stringify(value)
      const actual = JSON.stringify(liveNonSecretCredentials[key])
      if (expected !== actual) {
        diffs.push({ field: `credentials.${key}`, expected, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
