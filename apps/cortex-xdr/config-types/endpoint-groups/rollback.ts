import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError } from '../../lib/cortexXdrApi'
import { ENDPOINT_GROUP_ENDPOINTS, type CortexEndpointGroup } from './_shared'

/**
 * Undo an endpoint-group deploy from rollbackData.previous (written by deploy):
 * groups that existed before are RESTORED by re-creating their prior body; groups
 * this deploy CREATED (prior null) are DELETED by name.
 *
 * BEST-EFFORT / FLAGGED — like deploy, the create + delete endpoints are not
 * documented in the Cortex XDR public API and may 404. VERIFY the create/delete
 * paths + request envelopes against a live Cortex XDR tenant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; prior: CortexEndpointGroup | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for endpoint-group rollback' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const restores = previous.filter((p) => p.prior).map((p) => p.prior as CortexEndpointGroup)
  const deletes = previous.filter((p) => !p.prior).map((p) => p.name).filter(Boolean)

  try {
    for (const group of restores) {
      const res = await client.call(ENDPOINT_GROUP_ENDPOINTS.create, group as Record<string, unknown>)
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback restore failed: ${error}` }
    }
    for (const name of deletes) {
      const res = await client.call(ENDPOINT_GROUP_ENDPOINTS.delete, { name })
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback delete failed: ${error}` }
    }
    return {
      success: true,
      message: `Rolled back endpoint groups: ${restores.length} restored, ${deletes.length} deleted.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
