import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { IacRollbackData } from './deploy'

/**
 * Roll back IaC custom-rules settings by re-applying the `custom_rules` object
 * captured before deploy. If the org had never configured custom rules before
 * this deploy, there is nothing to restore — Snyk has no "clear" operation for
 * this resource, so leaving the deployed value in place is reported honestly
 * rather than guessed at.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back IaC settings.' }
  }

  const prior = (ctx.rollbackData as IacRollbackData | undefined)?.prior
  if (!prior || Object.keys(prior).length === 0) {
    return {
      success: false,
      message:
        'No previous IaC custom-rules settings captured for rollback — the organization had none configured ' +
        'before this deploy, and Snyk has no operation to clear custom_rules back to "unset".',
    }
  }

  const attrs: Record<string, unknown> = {}
  if (typeof prior.is_enabled === 'boolean') attrs.is_enabled = prior.is_enabled
  if (prior.inherit_from_parent) attrs.inherit_from_parent = prior.inherit_from_parent
  if (prior.oci_registry_url) attrs.oci_registry_url = prior.oci_registry_url
  if (prior.oci_registry_tag) attrs.oci_registry_tag = prior.oci_registry_tag

  const res = await client.rest('PATCH', `${client.restOrgPath()}/settings/iac`, {
    body: { data: { type: 'iac_settings', attributes: { custom_rules: attrs } } },
  })
  if (!res.ok) {
    return { success: false, message: `Failed to restore IaC settings: ${snykErrorMessage(res)}` }
  }

  return { success: true, message: 'Restored Snyk IaC custom-rules settings to their prior values' }
}
