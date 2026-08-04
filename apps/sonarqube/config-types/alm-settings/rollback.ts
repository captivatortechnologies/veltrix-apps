import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, postForm } from '../../lib/sonarqubeApi'
import { updateAction, restoreParams } from './_shared'

/**
 * Undo an ALM-settings deploy from rollbackData (written by deploy()):
 *   - a setting we CREATED (existed=false) is deleted (POST /api/alm_settings/delete).
 *   - a setting that already EXISTED has its non-secret identity fields restored via
 *     POST /api/alm_settings/update_<priorAlmType> — url/appId/clientId for github/gitlab/
 *     bitbucket/azure, or clientId/workspace for bitbucketcloud (which has no url).
 * Best-effort — a failure on one setting does not abort the rest.
 *
 * NOTE: SonarQube never returns a stored secret (personalAccessToken, clientSecret,
 * privateKey, webhookSecret) from any read action, so a secret changed by the deploy
 * CANNOT be restored to its prior value here. This is a documented, permanent limitation —
 * exactly parallel to the webhooks config type's secret handling.
 *
 * The restore call resends ALL the non-secret fields the deploy read back for this setting
 * (not just url), because update_github and update_bitbucketcloud both require appId /
 * clientId or clientId / workspace as well — sending url alone would make SonarQube reject
 * the restore for those two providers outright.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    settings?: Array<{
      key: string
      existed: boolean
      priorAlmType?: string
      priorUrl?: string
      priorAppId?: string
      priorClientId?: string
      priorWorkspace?: string
    }>
  }
  const settings = data.settings ?? []
  if (settings.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for ALM settings rollback' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let removed = 0
  let restored = 0
  let skipped = 0
  const failures: string[] = []

  for (const setting of settings) {
    try {
      if (!setting.existed) {
        await postForm(`${base}/api/alm_settings/delete`, headers, { key: setting.key })
        removed++
        continue
      }
      if (!setting.priorAlmType) {
        skipped++
        continue
      }
      await postForm(
        `${base}/api/alm_settings/${updateAction(setting.priorAlmType)}`,
        headers,
        restoreParams(setting.priorAlmType, {
          key: setting.key,
          url: setting.priorUrl,
          appId: setting.priorAppId,
          clientId: setting.priorClientId,
          workspace: setting.priorWorkspace,
        }),
      )
      restored++
    } catch (error) {
      failures.push(`${setting.key}: ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rollback partially failed: ${removed} removed, ${restored} restored${skipped ? `, ${skipped} skipped` : ''}. Errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back ALM settings: ${removed} removed, ${restored} restored${skipped ? `, ${skipped} skipped` : ''}.` }
}
