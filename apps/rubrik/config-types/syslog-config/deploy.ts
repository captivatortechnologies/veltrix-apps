import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'
import { buildSyslogBody, currentSyslogConfig, syslogConfigsEqual, LEGACY_SYSLOG_ID, type RubrikSyslogConfig } from './_shared'

export interface SyslogRollbackData {
  /** The cluster's syslog target before this deploy ran, or null if none was configured. */
  prior: RubrikSyslogConfig | null
}

/**
 * Deploy the Rubrik cluster's syslog export target — a SINGLETON, so there is no
 * list/match by name:
 *   GET    /api/internal/syslog          — read the current target (captured for rollback)
 *   DELETE /api/internal/syslog/{id}     — clear it, only when one exists and differs
 *   POST   /api/internal/syslog          — create the declared target
 * A declared target identical to the live one is a no-op. No field carries a
 * secret. Verify against a live Rubrik CDM cluster.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveServiceAccount(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }
  if (items.length === 0) {
    return { success: false, message: 'No syslog target declared.' }
  }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch (error) {
    return { success: false, message: `Rubrik connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  const desired = buildSyslogBody(items[0].fields) as RubrikSyslogConfig
  const rollbackData: SyslogRollbackData = { prior: null }

  try {
    const prior = currentSyslogConfig(await getJson<unknown>(conn, '/api/internal/syslog'))
    rollbackData.prior = prior

    if (syslogConfigsEqual(prior, desired)) {
      return {
        success: true,
        message: `Syslog target already configured: ${desired.hostname}:${desired.port} (${desired.protocol}).`,
        artifacts: { base: conn.base },
        rollbackData,
      }
    }

    if (prior) {
      await sendJson(conn, 'DELETE', `/api/internal/syslog/${encodeURIComponent(prior.id ?? LEGACY_SYSLOG_ID)}`)
    }
    await sendJson<RubrikSyslogConfig>(conn, 'POST', '/api/internal/syslog', desired)

    return {
      success: true,
      message: `Configured syslog target: ${desired.hostname}:${desired.port} (${desired.protocol}).`,
      artifacts: { base: conn.base, hostname: desired.hostname, protocol: desired.protocol, port: desired.port },
      rollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Syslog deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { base: conn.base },
      rollbackData,
    }
  }
}
