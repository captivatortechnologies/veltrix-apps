import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError } from '../../lib/cortexXdrApi'
import { IOC_ENDPOINTS, type CortexIoc } from './_shared'

/**
 * Undo an IOC deploy from rollbackData.previous (written by deploy()): indicators
 * that existed before are RESTORED by re-inserting their prior body
 * (POST /indicators/insert_jsons/); indicators this deploy CREATED (prior null)
 * are DELETED (POST /indicators/delete/ with their values). Applied over the
 * Cortex XDR public REST API.
 *
 * VERIFY the insert_jsons + delete request envelopes against a live Cortex XDR
 * tenant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ indicator: string; prior: CortexIoc | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for indicator rollback' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const restores = previous.filter((p) => p.prior).map((p) => p.prior as CortexIoc)
  const deletes = previous.filter((p) => !p.prior).map((p) => p.indicator).filter(Boolean)

  try {
    if (restores.length > 0) {
      const res = await client.post(IOC_ENDPOINTS.insert, { request_data: restores })
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback restore failed: ${error}` }
    }
    if (deletes.length > 0) {
      const res = await client.call(IOC_ENDPOINTS.delete, { indicators: deletes })
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback delete failed: ${error}` }
    }
    return {
      success: true,
      message: `Rolled back indicators: ${restores.length} restored, ${deletes.length} deleted.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
