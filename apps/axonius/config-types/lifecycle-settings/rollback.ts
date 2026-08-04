import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, sendJson, verifyTls } from '../../lib/axoniusApi'
import { LIFECYCLE_SETTINGS_RESOURCE, buildSettingsUpdateBody } from './_shared'

/**
 * Restore the Lifecycle Settings singleton to the prior FULL config recorded
 * in rollbackData.priorConfig (written by deploy()) — a verbatim PUT, not a
 * merge, since we already have the complete prior state. Applied over the
 * Axonius REST API (443). Verify against a live Axonius tenant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { priorConfig?: Record<string, unknown> }
  const priorConfig = data.priorConfig
  if (!priorConfig) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for lifecycle-settings rollback' }
  }
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) {
    return { success: false, message: 'Axonius needs an API key (username) and API secret (token) to roll back.' }
  }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)
  const opts = { verifyTls: verifyTls(settings) }

  try {
    await sendJson('PUT', apiUrl(base, settings, LIFECYCLE_SETTINGS_RESOURCE), headers, buildSettingsUpdateBody(priorConfig), opts)
    return { success: true, message: 'Rolled back lifecycle settings.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
