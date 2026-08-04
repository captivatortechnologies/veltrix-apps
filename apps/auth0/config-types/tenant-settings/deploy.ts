import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, getJson, sendJson } from '../../lib/auth0Api'
import { buildTenantSettingsBody } from './_shared'

const TENANT_SETTINGS_PATH = 'tenants/settings'

/**
 * Deploy Auth0 Tenant Settings over the Management API v2: GET the current
 * settings first (a rollback snapshot of at least the managed subset), then
 * PATCH the managed body built from canvas fields. rollbackData also records
 * which flag keys this deploy actually touched, so rollback restores only
 * those flags' prior values (see _shared.ts for why flags are a partial-merge).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  if (!item) return { success: true, message: 'No tenant settings configured.', rollbackData: {} }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 deployment' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    const body = buildTenantSettingsBody(item.fields)
    const prior = await getJson<Record<string, unknown>>(`${base}/${TENANT_SETTINGS_PATH}`, accessToken)
    await sendJson('PATCH', `${base}/${TENANT_SETTINGS_PATH}`, accessToken, body)

    const touchedFlagKeys = Object.keys(body.flags ?? {})
    const priorFlags: Record<string, boolean> = {}
    if (touchedFlagKeys.length > 0) {
      const liveFlags = (prior.flags ?? {}) as Record<string, unknown>
      for (const key of touchedFlagKeys) {
        priorFlags[key] = liveFlags[key] === true
      }
    }

    return {
      success: true,
      message: 'Applied Auth0 tenant settings.',
      rollbackData: { prior, priorFlags, touchedFlagKeys },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 tenant settings deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
