import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, restResult, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import { buildCustomRulesAttributes, extractIacSettings, type LiveIacCustomRules } from './validate'

export interface IacRollbackData {
  prior: LiveIacCustomRules | null
}

/** The JSON:API resource returned by GET/PATCH /orgs/{org_id}/settings/iac. */
interface LiveIacSettings {
  id?: string
  type?: string
  attributes?: { custom_rules?: LiveIacCustomRules }
}

/**
 * Deploy Snyk Infrastructure as Code (IaC) custom-rules settings for the org.
 *
 * A singleton: GET the current `custom_rules` object (captured for rollback),
 * then PATCH /orgs/{org_id}/settings/iac with the declared shape. Snyk requires
 * at least one property in `custom_rules` on every PATCH; `is_enabled` is
 * always sent so that requirement is always satisfied.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — configure the "Organization ID" app setting.' }
  }

  const spec = extractIacSettings(ctx.canvas)

  try {
    const prior = await readIacCustomRules(client)

    const res = await client.rest('PATCH', `${client.restOrgPath()}/settings/iac`, {
      body: { data: { type: 'iac_settings', attributes: { custom_rules: buildCustomRulesAttributes(spec) } } },
    })
    if (!res.ok) {
      return {
        success: false,
        message: `Failed to update Snyk IaC settings: ${snykErrorMessage(res)}`,
        rollbackData: { prior } satisfies IacRollbackData,
      }
    }

    return {
      success: true,
      message: `Snyk IaC custom rules ${spec.isEnabled ? 'enabled' : 'disabled'} for the organization on ${host}`,
      artifacts: { host, isEnabled: spec.isEnabled, inheritFromParent: spec.inheritFromParent },
      rollbackData: { prior } satisfies IacRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `IaC settings deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

/** GET the current `custom_rules` object; null when the org never configured one. Throws on a non-OK response. */
export async function readIacCustomRules(client: SnykClient): Promise<LiveIacCustomRules | null> {
  const res = await client.rest('GET', `${client.restOrgPath()}/settings/iac`)
  if (!res.ok) {
    throw new Error(`Failed to read IaC settings: ${snykErrorMessage(res)}`)
  }
  const data = restResult<LiveIacSettings>(res)
  return data?.attributes?.custom_rules ?? null
}
