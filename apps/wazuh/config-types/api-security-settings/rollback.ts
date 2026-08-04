import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, sendJson, wazuhRequest } from '../../lib/wazuhApi'
import type { SecuritySettingsBody } from './_shared'

/**
 * Undo an API-security-settings deploy from rollbackData.previous (written by
 * deploy()): PUT the prior body back, or — when deploy's pre-write GET
 * couldn't read a prior snapshot — DELETE /security/config, Wazuh's own
 * "restore defaults" operation. Applied over the Wazuh REST API (55000).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: SecuritySettingsBody | null }

  if (!credential) {
    return { success: false, message: 'Missing credential for API-security-settings rollback' }
  }

  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    if (data.previous) {
      await sendJson('PUT', `${baseUrl}/security/config`, auth, data.previous)
      return {
        success: true,
        message: `Restored prior API security settings (auth_token_exp_timeout=${data.previous.auth_token_exp_timeout}, rbac_mode=${data.previous.rbac_mode}).`,
      }
    }

    const url = `${baseUrl}/security/config`
    const res = await wazuhRequest(url, { method: 'DELETE', headers: auth })
    if (!res.ok) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return { success: true, message: 'No prior settings snapshot was available — reset API security settings to Wazuh defaults instead.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
