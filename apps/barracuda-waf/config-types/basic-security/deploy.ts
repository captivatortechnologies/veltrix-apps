import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import { buildBasicSecurityBody, extractBasicSecuritySpec, getBasicSecurity, type LiveBasicSecurity } from './validate'

export interface BasicSecurityRollbackData {
  prior: LiveBasicSecurity
}

/**
 * Deploy the Basic Security singleton: PATCH /applications/{appName}/basic_security/
 * { protection_mode }. The prior value is captured so rollback can restore it.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, appName } = built

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    return { success: true, message: 'No Basic Security configured.', rollbackData: {} }
  }
  const spec = extractBasicSecuritySpec(ctx.canvas)

  try {
    const prior = await getBasicSecurity(client, appName)
    const body = buildBasicSecurityBody(spec)
    const res = await client.request('PATCH', `${client.appPath(appName)}/basic_security/`, { body })
    if (!res.ok) throw new Error(`Failed to update Basic Security: ${barracudaErrorMessage(res)}`)

    return {
      success: true,
      message: `Deployed Basic Security to Application "${appName}": protection mode ${body.protection_mode}.`,
      artifacts: { baseUrl, appName, protectionMode: body.protection_mode },
      rollbackData: { prior } satisfies BasicSecurityRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Basic Security deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl, appName },
    }
  }
}
