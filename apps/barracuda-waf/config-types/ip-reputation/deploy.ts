import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import { buildIpReputationBody, extractIpReputationSpec, getIpReputation, type LiveIpReputation } from './validate'

export interface IpReputationRollbackData {
  prior: LiveIpReputation
}

/**
 * Deploy the IP Reputation singleton: PATCH /applications/{appName}/ip_reputation/
 * with the full managed object (every field is explicitly declared). The prior
 * value is captured so rollback can restore it exactly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, appName } = built

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    return { success: true, message: 'No IP Reputation configured.', rollbackData: {} }
  }
  const spec = extractIpReputationSpec(ctx.canvas)
  if (spec.exceptionsError) {
    return { success: false, message: `IP Reputation deployment failed: exceptions ${spec.exceptionsError}` }
  }

  try {
    const prior = await getIpReputation(client, appName)
    const body = buildIpReputationBody(spec)
    const res = await client.request('PATCH', `${client.appPath(appName)}/ip_reputation/`, { body })
    if (!res.ok) throw new Error(`Failed to update IP Reputation: ${barracudaErrorMessage(res)}`)

    return {
      success: true,
      message:
        `Deployed IP Reputation to Application "${appName}": ${body.enabled ? 'enabled' : 'disabled'}, ` +
        `${spec.blockedCountries.length} blocked countr${spec.blockedCountries.length === 1 ? 'y' : 'ies'}, ` +
        `${spec.exceptions.length} exception(s).`,
      artifacts: { baseUrl, appName },
      rollbackData: { prior } satisfies IpReputationRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `IP Reputation deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl, appName },
    }
  }
}
