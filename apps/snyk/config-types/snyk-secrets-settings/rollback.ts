import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { SecretsRollbackData } from './deploy'

/**
 * Roll back Secrets settings by re-applying the value captured before deploy.
 * If no prior settings were captured (e.g. the org had never set them), there
 * is nothing to restore.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back Secrets settings.' }
  }

  const prior = (ctx.rollbackData as SecretsRollbackData | undefined)?.prior
  if (!prior || typeof prior.secrets_enabled !== 'boolean') {
    return { success: false, message: 'No previous Secrets settings captured for rollback' }
  }

  const res = await client.rest('PATCH', `${client.restOrgPath()}/settings/secrets`, {
    body: { data: { type: 'secrets_settings', attributes: { secrets_enabled: prior.secrets_enabled } } },
  })
  if (!res.ok) {
    return { success: false, message: `Failed to restore Secrets settings: ${snykErrorMessage(res)}` }
  }

  return { success: true, message: `Restored Snyk Secrets scanning to ${prior.secrets_enabled ? 'enabled' : 'disabled'}` }
}
