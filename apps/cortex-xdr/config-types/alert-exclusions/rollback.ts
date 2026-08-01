import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError } from '../../lib/cortexXdrApi'
import { ALERT_EXCLUSION_ENDPOINTS, type CortexAlertExclusion } from './_shared'

/**
 * Undo an alert-exclusion deploy from rollbackData.previous (written by deploy):
 * exclusions that existed before are RESTORED by re-creating their prior body;
 * exclusions this deploy CREATED (prior null) are DELETED by name.
 *
 * SPECULATIVE / BEST-EFFORT — like deploy, the create + delete endpoints are not
 * documented in the Cortex XDR public API and will likely 404. VERIFY every path
 * + request envelope against a live Cortex XDR tenant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; prior: CortexAlertExclusion | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for alert-exclusion rollback' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const restores = previous.filter((p) => p.prior).map((p) => p.prior as CortexAlertExclusion)
  const deletes = previous.filter((p) => !p.prior).map((p) => p.name).filter(Boolean)

  try {
    for (const exclusion of restores) {
      const res = await client.call(ALERT_EXCLUSION_ENDPOINTS.create, exclusion as Record<string, unknown>)
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback restore failed: ${error}` }
    }
    for (const name of deletes) {
      const res = await client.call(ALERT_EXCLUSION_ENDPOINTS.delete, { name })
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback delete failed: ${error}` }
    }
    return {
      success: true,
      message: `Rolled back alert exclusions: ${restores.length} restored, ${deletes.length} deleted.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
