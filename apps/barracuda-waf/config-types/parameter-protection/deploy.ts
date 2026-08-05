import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import { buildParameterProtectionBody, extractParameterProtectionSpec, getParameterProtection, type LiveParameterProtection } from './validate'

export interface ParameterProtectionRollbackData {
  prior: LiveParameterProtection
}

/**
 * Deploy the Parameter Protection singleton: PATCH
 * /applications/{appName}/parameter_protection/ with the full managed object
 * (every field is explicitly declared). The prior value is captured so
 * rollback can restore it exactly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, appName } = built

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    return { success: true, message: 'No Parameter Protection configured.', rollbackData: {} }
  }
  const spec = extractParameterProtectionSpec(ctx.canvas)

  try {
    const prior = await getParameterProtection(client, appName)
    const body = buildParameterProtectionBody(spec)
    const res = await client.request('PATCH', `${client.appPath(appName)}/parameter_protection/`, { body })
    if (!res.ok) throw new Error(`Failed to update Parameter Protection: ${barracudaErrorMessage(res)}`)

    return {
      success: true,
      message:
        `Deployed Parameter Protection to Application "${appName}": ${body.enabled ? 'enabled' : 'disabled'}, ` +
        `max value length ${spec.maximumParameterValueLength}, max instances ${spec.maximumInstances}.`,
      artifacts: { baseUrl, appName },
      rollbackData: { prior } satisfies ParameterProtectionRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Parameter Protection deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl, appName },
    }
  }
}
