import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, getJson, sendJson } from '../../lib/wazuhApi'
import { specFromItem, toSecurityConfigBody, type SecuritySettingsBody } from './_shared'

/**
 * Deploy the Wazuh API security-settings SINGLETON over the REST API (55000):
 *   read (rollback): GET ${base}/security/config   (best-effort)
 *   apply:           PUT ${base}/security/config   { auth_token_exp_timeout, rbac_mode }
 *
 * Only the FIRST canvas item is applied (see validate.ts's SINGLETON_EXCESS
 * warning). `comment` is audit-only and is never sent to the manager.
 *
 * rollbackData.previous records the prior `{ auth_token_exp_timeout, rbac_mode }`
 * (null if the pre-deploy GET failed) so rollback can PUT it back, or — with no
 * snapshot — fall back to DELETE (Wazuh's own "restore defaults" operation).
 */
interface SecurityConfigEnvelope {
  data?: SecuritySettingsBody
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (items.length === 0) {
    return { success: false, message: 'No Security Settings item to deploy' }
  }
  if (!credential) {
    return { success: false, message: 'Missing credential for API-security-settings deployment' }
  }

  const body = toSecurityConfigBody(specFromItem(items[0]))
  let previous: SecuritySettingsBody | null = null

  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    try {
      const envelope = await getJson<SecurityConfigEnvelope>(`${baseUrl}/security/config`, auth)
      previous = envelope.data ?? null
    } catch {
      previous = null // best-effort — rollback falls back to DELETE (restore defaults)
    }

    await sendJson('PUT', `${baseUrl}/security/config`, auth, body)

    return {
      success: true,
      message: `Applied API security settings (auth_token_exp_timeout=${body.auth_token_exp_timeout}, rbac_mode=${body.rbac_mode}).`,
      artifacts: { applied: body },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `API-security-settings deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      rollbackData: { previous },
    }
  }
}
