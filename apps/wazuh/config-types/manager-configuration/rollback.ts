import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, wazuhRequest } from '../../lib/wazuhApi'

/**
 * Undo a manager-configuration deploy from rollbackData.previous (written by
 * deploy()): PUT the prior raw ossec.conf body back, then best-effort restart
 * to reload it. Applied over the Wazuh REST API (55000).
 *
 * There is no "restore defaults" operation for ossec.conf (unlike the API
 * Security Settings config type's `/security/config` DELETE) — every manager
 * MUST have some configuration. When deploy's pre-write GET couldn't capture a
 * prior snapshot, rollback has nothing safe to apply and reports that plainly
 * rather than guessing.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: string | null }

  if (data.previous == null) {
    return {
      success: false,
      message: 'No prior configuration snapshot is available to restore — this manager likely had no readable ossec.conf before deploy. Manual recovery is required.',
    }
  }

  if (!credential) {
    return { success: false, message: 'Missing credential for manager-configuration rollback' }
  }

  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const auth = bearerHeader(token)

    const url = `${baseUrl}/manager/configuration`
    const res = await wazuhRequest(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...auth },
      body: data.previous,
    })
    if (!res.ok) throw new Error(`PUT ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)

    let restart = 'skipped'
    try {
      const restartRes = await wazuhRequest(`${baseUrl}/manager/restart`, { method: 'PUT', headers: auth })
      restart = restartRes.ok ? `requested (HTTP ${restartRes.status})` : `not confirmed (HTTP ${restartRes.status})`
    } catch (error) {
      restart = `failed (${error instanceof Error ? error.message : 'error'})`
    }

    return { success: true, message: `Restored the prior manager configuration. Manager restart: ${restart}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
