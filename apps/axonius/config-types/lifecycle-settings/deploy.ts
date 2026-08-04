import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, sendJson, verifyTls } from '../../lib/axoniusApi'
import { LIFECYCLE_SETTINGS_RESOURCE, configFromResponse, buildSettingsUpdateBody, mergeOverrides, parseOverrides } from './_shared'

/**
 * Deploy the Lifecycle Settings singleton over the REST API (443):
 *   read:  GET api/settings/plugins/system_scheduler/SystemSchedulerService → prior full config (the rollback snapshot)
 *   write: PUT api/settings/plugins/system_scheduler/SystemSchedulerService → the prior config
 *          shallow-merged with the declared `overrides` (declared keys win,
 *          everything else preserved verbatim)
 *
 * rollbackData stores the prior FULL config verbatim, so rollback can restore
 * it exactly regardless of what this deploy changed. Verify against a live
 * Axonius tenant.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  if (!item) return { success: true, message: 'No lifecycle settings configured.', rollbackData: {} }

  if (!credential) {
    return { success: false, message: 'Missing credential for lifecycle-settings deployment' }
  }
  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) {
    return { success: false, message: 'Axonius needs an API key (username) and API secret (token) — attach both to this connection.' }
  }
  const opts = { verifyTls: verifyTls(settings) }

  const overrides = parseOverrides(item.fields.overrides)
  if (!overrides.ok) {
    return { success: false, message: `Lifecycle settings overrides are invalid: ${overrides.error}` }
  }

  try {
    const priorConfig = configFromResponse(
      await getJson<unknown>(apiUrl(base, settings, LIFECYCLE_SETTINGS_RESOURCE), headers, { verifyTls: verifyTls(settings) }),
    )
    const mergedConfig = mergeOverrides(priorConfig, overrides.value)

    await sendJson('PUT', apiUrl(base, settings, LIFECYCLE_SETTINGS_RESOURCE), headers, buildSettingsUpdateBody(mergedConfig), opts)

    return {
      success: true,
      message: `Applied lifecycle settings overrides (${Object.keys(overrides.value).length} key${Object.keys(overrides.value).length === 1 ? '' : 's'}).`,
      rollbackData: { priorConfig },
    }
  } catch (error) {
    return { success: false, message: `Lifecycle-settings deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
