import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'
import { currentSyslogConfig, LEGACY_SYSLOG_ID, type RubrikSyslogConfig } from './_shared'
import type { SyslogRollbackData } from './deploy'

/**
 * Undo a syslog deploy from rollbackData.prior (written by deploy()):
 *   - clear whatever the deploy left configured (DELETE the current target, if any)
 *   - if a target existed BEFORE the deploy, recreate it (POST the prior hostname/protocol/port)
 *   - if none existed before, the cluster is left with no syslog target
 * Applied over the Rubrik CDM internal REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as SyslogRollbackData

  if (!resolveServiceAccount(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch (error) {
    return { success: false, message: `Rubrik connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    const current = currentSyslogConfig(await getJson<unknown>(conn, '/api/internal/syslog'))
    if (current) {
      await sendJson(conn, 'DELETE', `/api/internal/syslog/${encodeURIComponent(current.id ?? LEGACY_SYSLOG_ID)}`)
    }

    if (data.prior) {
      const body: RubrikSyslogConfig = { hostname: data.prior.hostname, protocol: data.prior.protocol, port: data.prior.port }
      await sendJson(conn, 'POST', '/api/internal/syslog', body)
      return { success: true, message: `Restored prior syslog target: ${body.hostname}:${body.port} (${body.protocol}).` }
    }

    return { success: true, message: 'Cleared the syslog target — none was configured before this deploy.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
