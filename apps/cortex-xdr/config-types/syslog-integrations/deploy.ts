import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError, type CortexXdrClient } from '../../lib/cortexXdrApi'
import {
  SYSLOG_ENDPOINTS,
  buildSyslogIntegrationBody,
  findSyslogIntegration,
  syslogIntegrationsFromReply,
  type LiveSyslogIntegration,
} from './_shared'

/**
 * Deploy Cortex XDR syslog integrations over the public REST API — a genuine
 * full CRUD surface:
 *   read (identity + rollback): POST /integrations/syslog/get/    → real list
 *   create:                     POST /integrations/syslog/create/
 *   update:                     POST /integrations/syslog/update/  (needs syslog_id)
 *
 * A syslog integration has no caller-chosen identity — Cortex assigns
 * `syslog_integration_id` on create — so this reconciles by NAME: list -> match
 * a live integration by name -> update it by id, or create a new one.
 * rollbackData records, per name, the prior live snapshot (null when it did not
 * exist) so rollback can restore it or delete the one we created.
 *
 * NOTE: `certificate_content` is write-only — /integrations/syslog/get never
 * returns it, so a rollback restore cannot recover a cleared certificate; see
 * rollback.ts.
 *
 * VERIFY every endpoint path + field name against a live Cortex XDR tenant.
 */
async function listSyslogIntegrations(client: CortexXdrClient): Promise<LiveSyslogIntegration[]> {
  try {
    const res = await client.call(SYSLOG_ENDPOINTS.get, {})
    if (!res.ok) return []
    return syslogIntegrationsFromReply(res.reply)
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for syslog-integration deployment' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: Array<{ name: string; prior: LiveSyslogIntegration | null }> = []
  const applied: string[] = []

  try {
    const live = await listSyslogIntegrations(client)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const body = buildSyslogIntegrationBody(item.fields)
      const match = findSyslogIntegration(live, name)
      previous.push({ name, prior: match })

      let res
      if (match?.SYSLOG_INTEGRATION_ID !== undefined) {
        res = await client.call(SYSLOG_ENDPOINTS.update, { ...body, syslog_id: String(match.SYSLOG_INTEGRATION_ID) })
      } else {
        res = await client.call(SYSLOG_ENDPOINTS.create, body as unknown as Record<string, unknown>)
      }
      const error = cortexWriteError(res)
      if (error) {
        return {
          success: false,
          message: `Syslog-integration deploy failed for "${name}": ${error}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} syslog integration(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Syslog-integration deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
