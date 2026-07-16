import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { SastRollbackData } from './deploy'

/**
 * Roll back SAST settings by re-applying the value captured before deploy.
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
    return { success: false, message: 'No Snyk organization id set — cannot roll back SAST settings.' }
  }

  const prior = (ctx.rollbackData as SastRollbackData | undefined)?.prior
  if (!prior || typeof prior.sast_enabled !== 'boolean') {
    return { success: false, message: 'No previous SAST settings captured for rollback' }
  }

  const res = await client.rest('PATCH', `${client.restOrgPath()}/settings/sast`, {
    body: { data: { type: 'sast_settings', attributes: { sast_enabled: prior.sast_enabled } } },
  })
  if (!res.ok) {
    return { success: false, message: `Failed to restore SAST settings: ${snykErrorMessage(res)}` }
  }

  return { success: true, message: `Restored Snyk Code (SAST) to ${prior.sast_enabled ? 'enabled' : 'disabled'}` }
}
