import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'
import { assertSettingSaved, type ServerSettingsEditResponse } from './_shared'

/**
 * Undo an admin-settings deploy from rollbackData.settings (written by deploy()):
 * for each entry, POST /servers/serverSettingsEdit/<name> with `force: true` to
 * restore its prior value. There is no "unset" concept for a MISP server setting
 * (they always pre-exist with some value), so rollback always restores rather
 * than deletes. Applied over the MISP REST API (443). Verify
 * /servers/serverSettingsEdit/<name> against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    settings?: Array<{ name: string; hadPrior: boolean; priorValue: unknown }>
  }
  const settings = data.settings ?? []
  if (settings.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for admin settings rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  try {
    for (const { name, priorValue } of settings) {
      const result = await sendJson<ServerSettingsEditResponse>(
        'POST',
        `${base}/servers/serverSettingsEdit/${encodeURIComponent(name)}`,
        headers,
        { value: String(priorValue ?? ''), force: true },
      )
      assertSettingSaved(name, result)
      restored++
    }
    return { success: true, message: `Rolled back ${restored} setting(s) to their prior value.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
