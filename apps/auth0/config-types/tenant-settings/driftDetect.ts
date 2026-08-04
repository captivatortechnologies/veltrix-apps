import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, getJson } from '../../lib/auth0Api'
import { stringSetsEqual } from '../../lib/fields'
import { buildTenantSettingsBody } from './_shared'

const TENANT_SETTINGS_PATH = 'tenants/settings'

const SCALAR_KEYS = [
  'friendly_name',
  'support_email',
  'support_url',
  'picture_url',
  'default_audience',
  'default_directory',
  'default_redirection_uri',
  'sandbox_version',
] as const

/**
 * Drift for Auth0 Tenant Settings: compare every always-declared scalar/array
 * field, and each declared flag key, against the live GET /tenants/settings.
 * Best-effort — a read error yields no drift, not a failure. Read-only.
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

  let live: Record<string, unknown>
  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    live = await getJson<Record<string, unknown>>(`${base}/${TENANT_SETTINGS_PATH}`, accessToken)
  } catch {
    return { hasDrift: false, diffs }
  }

  const desired = buildTenantSettingsBody(item.fields)

  for (const key of SCALAR_KEYS) {
    const actual = typeof live[key] === 'string' ? (live[key] as string) : ''
    if (desired[key] !== actual) {
      diffs.push({ field: key, expected: desired[key], actual, severity: 'warning' })
    }
  }

  const liveEnabledLocales = Array.isArray(live.enabled_locales) ? (live.enabled_locales as string[]) : []
  if (!stringSetsEqual(desired.enabled_locales, liveEnabledLocales)) {
    diffs.push({ field: 'enabled_locales', expected: desired.enabled_locales, actual: liveEnabledLocales, severity: 'warning' })
  }

  const liveAllowedLogoutUrls = Array.isArray(live.allowed_logout_urls) ? (live.allowed_logout_urls as string[]) : []
  if (!stringSetsEqual(desired.allowed_logout_urls, liveAllowedLogoutUrls)) {
    diffs.push({ field: 'allowed_logout_urls', expected: desired.allowed_logout_urls, actual: liveAllowedLogoutUrls, severity: 'warning' })
  }

  if (desired.session_lifetime !== undefined) {
    const actual = typeof live.session_lifetime === 'number' ? live.session_lifetime : undefined
    if (desired.session_lifetime !== actual) {
      diffs.push({ field: 'session_lifetime', expected: desired.session_lifetime, actual, severity: 'warning' })
    }
  }
  if (desired.idle_session_lifetime !== undefined) {
    const actual = typeof live.idle_session_lifetime === 'number' ? live.idle_session_lifetime : undefined
    if (desired.idle_session_lifetime !== actual) {
      diffs.push({ field: 'idle_session_lifetime', expected: desired.idle_session_lifetime, actual, severity: 'warning' })
    }
  }

  if (desired.flags) {
    const liveFlags = (live.flags ?? {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(desired.flags)) {
      if (liveFlags[key] !== value) {
        diffs.push({ field: `flags.${key}`, expected: value, actual: liveFlags[key], severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
