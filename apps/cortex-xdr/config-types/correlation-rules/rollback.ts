import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError } from '../../lib/cortexXdrApi'
import { CORRELATION_ENDPOINTS, type CortexCorrelationRule } from './_shared'

/**
 * Undo a correlation-rule deploy from rollbackData.previous (written by
 * deploy()): rules that existed before are RESTORED by re-inserting their prior
 * body (which carries their `rule_id`, so /correlations/insert/ updates them in
 * place); rules this deploy CREATED (prior null) are DELETED via
 * /correlations/delete/ with a name filter.
 *
 * VERIFY the insert + delete request envelopes against a live Cortex XDR tenant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; prior: CortexCorrelationRule | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for correlation-rule rollback' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const restores = previous.filter((p) => p.prior).map((p) => p.prior as CortexCorrelationRule)
  const deleteNames = previous.filter((p) => !p.prior).map((p) => p.name).filter(Boolean)

  try {
    if (restores.length > 0) {
      const res = await client.post(CORRELATION_ENDPOINTS.insert, { request_data: restores })
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback restore failed: ${error}` }
    }
    if (deleteNames.length > 0) {
      const res = await client.call(CORRELATION_ENDPOINTS.delete, {
        filters: [{ field: 'name', operator: 'IN', value: deleteNames }],
      })
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback delete failed: ${error}` }
    }
    return {
      success: true,
      message: `Rolled back correlation rules: ${restores.length} restored, ${deleteNames.length} deleted.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
