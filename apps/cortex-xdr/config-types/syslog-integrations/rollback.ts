import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError } from '../../lib/cortexXdrApi'
import { SYSLOG_ENDPOINTS, type LiveSyslogIntegration } from './_shared'

/**
 * Undo a syslog-integration deploy from rollbackData.previous (written by
 * deploy()): integrations that existed before are RESTORED via
 * /integrations/syslog/update/ using their prior live snapshot; integrations
 * this deploy CREATED (prior null) are DELETED via /integrations/syslog/delete/
 * with a name filter.
 *
 * NOTE: `certificate_content` is write-only — the prior snapshot came from
 * /integrations/syslog/get/, which never returns it — so a restore cannot recover
 * a certificate that was changed or cleared by the deploy being rolled back. This
 * is reported, not silently guessed.
 *
 * VERIFY the update + delete request envelopes against a live Cortex XDR tenant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; prior: LiveSyslogIntegration | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for syslog-integration rollback' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const restores = previous.filter((p) => p.prior)
  const deleteNames = previous.filter((p) => !p.prior).map((p) => p.name).filter(Boolean)
  let certificateContentSkipped = false

  try {
    for (const { prior } of restores) {
      const p = prior as LiveSyslogIntegration
      const body: Record<string, unknown> = {
        syslog_id: String(p.SYSLOG_INTEGRATION_ID),
        name: p.SYSLOG_INTEGRATION_NAME,
        address: p.SYSLOG_INTEGRATION_ADDRESS,
        port: p.SYSLOG_INTEGRATION_PORT,
        protocol: p.SYSLOG_INTEGRATION_PROTOCOL,
      }
      if (p.FACILITY) body.facility = p.FACILITY
      certificateContentSkipped = true // the prior snapshot never carries certificate_content — see file header
      const res = await client.call(SYSLOG_ENDPOINTS.update, body)
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback restore failed: ${error}` }
    }
    if (deleteNames.length > 0) {
      const res = await client.call(SYSLOG_ENDPOINTS.delete, {
        filters: [{ field: 'name', operator: 'eq', value: deleteNames[0] }],
      })
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback delete failed: ${error}` }
      // The delete endpoint's documented filter shape takes one value per call —
      // apply it per remaining name so every created integration is removed.
      for (const name of deleteNames.slice(1)) {
        const res2 = await client.call(SYSLOG_ENDPOINTS.delete, { filters: [{ field: 'name', operator: 'eq', value: name }] })
        const error2 = cortexWriteError(res2)
        if (error2) return { success: false, message: `Rollback delete failed for "${name}": ${error2}` }
      }
    }
    return {
      success: true,
      message:
        `Rolled back syslog integrations: ${restores.length} restored, ${deleteNames.length} deleted.` +
        (certificateContentSkipped ? ' NOTE: TLS certificate content could not be restored (write-only field) — re-upload it manually if it changed.' : ''),
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
