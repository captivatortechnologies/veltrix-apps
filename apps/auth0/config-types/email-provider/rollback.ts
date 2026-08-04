import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, sendJson, deleteResource } from '../../lib/auth0Api'
import { EMAIL_PROVIDER_PATH, type EmailProviderSnapshot } from './_shared'

/**
 * Undo an email-provider deploy from rollbackData (written by deploy()): when
 * a provider existed before (existed: true), PATCH back its non-secret prior
 * fields — name, enabled, default_from_address, settings. Credential SECRET
 * values are never restored: Auth0 never returns them on a read, so the
 * `credentials` key is deliberately left out of this PATCH body; re-enter
 * credentials afterward if the exact prior secret values matter. When this
 * deploy created the provider (existed: false), DELETE it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { existed?: boolean; prior?: EmailProviderSnapshot | null }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 rollback' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)
  const url = `${base}/${EMAIL_PROVIDER_PATH}`

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    if (data.existed && data.prior) {
      await sendJson('PATCH', url, accessToken, {
        name: data.prior.name,
        enabled: data.prior.enabled,
        default_from_address: data.prior.default_from_address,
        settings: data.prior.settings,
      })
      return {
        success: true,
        message:
          'Restored the prior email provider name/enabled/from-address/settings. Credential secret values could not be restored (Auth0 never returns them) — re-enter them if needed.',
      }
    }

    if (data.existed === false) {
      await deleteResource(url, accessToken)
      return { success: true, message: 'Removed the email provider this deploy configured.' }
    }

    return { success: true, message: 'Nothing to roll back.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
