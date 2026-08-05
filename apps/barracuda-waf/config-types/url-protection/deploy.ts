import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import { buildUrlProtectionBody, extractUrlProtectionSpec, getUrlProtection, type LiveUrlProtection } from './validate'

export interface UrlProtectionRollbackData {
  prior: LiveUrlProtection
}

/**
 * Deploy the URL Protection singleton: PATCH
 * /applications/{appName}/url_protection/ with the full managed object
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
    return { success: true, message: 'No URL Protection configured.', rollbackData: {} }
  }
  const spec = extractUrlProtectionSpec(ctx.canvas)

  try {
    const prior = await getUrlProtection(client, appName)
    const body = buildUrlProtectionBody(spec)
    const res = await client.request('PATCH', `${client.appPath(appName)}/url_protection/`, { body })
    if (!res.ok) throw new Error(`Failed to update URL Protection: ${barracudaErrorMessage(res)}`)

    return {
      success: true,
      message:
        `Deployed URL Protection to Application "${appName}": ${body.enabled ? 'enabled' : 'disabled'}, ` +
        `CSRF prevention "${spec.csrfPrevention}", ${spec.allowedMethods.length} allowed method(s).`,
      artifacts: { baseUrl, appName },
      rollbackData: { prior } satisfies UrlProtectionRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `URL Protection deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl, appName },
    }
  }
}
