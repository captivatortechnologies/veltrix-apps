import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, sendJson } from '../../lib/auth0Api'
import type { TenantSettingsBody } from './_shared'

const TENANT_SETTINGS_PATH = 'tenants/settings'

/**
 * Restore the managed tenant-settings fields to their prior values, and the
 * prior VALUES of only the flag keys this deploy actually touched — never
 * touching (let alone clearing) a flag outside that set, since `flags` is a
 * partial-merge on Auth0's side (see _shared.ts).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    prior?: Record<string, unknown>
    priorFlags?: Record<string, boolean>
    touchedFlagKeys?: string[]
  }
  const prior = data.prior
  if (!prior) return { success: true, message: 'Nothing to roll back.' }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 rollback' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  const body: Partial<TenantSettingsBody> = {
    friendly_name: typeof prior.friendly_name === 'string' ? prior.friendly_name : '',
    support_email: typeof prior.support_email === 'string' ? prior.support_email : '',
    support_url: typeof prior.support_url === 'string' ? prior.support_url : '',
    picture_url: typeof prior.picture_url === 'string' ? prior.picture_url : '',
    default_audience: typeof prior.default_audience === 'string' ? prior.default_audience : '',
    default_directory: typeof prior.default_directory === 'string' ? prior.default_directory : '',
    default_redirection_uri: typeof prior.default_redirection_uri === 'string' ? prior.default_redirection_uri : '',
    sandbox_version: typeof prior.sandbox_version === 'string' ? prior.sandbox_version : '',
    enabled_locales: Array.isArray(prior.enabled_locales) ? (prior.enabled_locales as string[]) : [],
    allowed_logout_urls: Array.isArray(prior.allowed_logout_urls) ? (prior.allowed_logout_urls as string[]) : [],
  }
  if (typeof prior.session_lifetime === 'number') body.session_lifetime = prior.session_lifetime
  if (typeof prior.idle_session_lifetime === 'number') body.idle_session_lifetime = prior.idle_session_lifetime

  const touchedFlagKeys = data.touchedFlagKeys ?? []
  if (touchedFlagKeys.length > 0) {
    const priorFlags = data.priorFlags ?? {}
    body.flags = Object.fromEntries(touchedFlagKeys.map((key) => [key, priorFlags[key] === true]))
  }

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    await sendJson('PATCH', `${base}/${TENANT_SETTINGS_PATH}`, accessToken, body)
    return { success: true, message: 'Rolled back Auth0 tenant settings.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
