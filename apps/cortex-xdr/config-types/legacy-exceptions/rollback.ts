import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError } from '../../lib/cortexXdrApi'
import { LEGACY_EXCEPTION_ENDPOINTS, type LiveLegacyException } from './_shared'

/**
 * Undo a legacy-exception deploy from rollbackData.previous (written by
 * deploy()): exceptions that existed before are RESTORED via
 * /legacy_exceptions/edit/ using their prior live snapshot; exceptions this
 * deploy created (prior null) are DELETED via /legacy_exceptions/delete/ when
 * the created exception_id was captured from the add response.
 *
 * VERIFY the edit + delete request envelopes against a live Cortex XDR tenant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; prior: LiveLegacyException | null; createdId?: string }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for legacy-exception rollback' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const restores = previous.filter((p) => p.prior)
  const deletable = previous.filter((p) => !p.prior && p.createdId)
  const unrecoverable = previous.filter((p) => !p.prior && !p.createdId)

  try {
    for (const { prior } of restores) {
      const p = prior as LiveLegacyException
      const res = await client.call(LEGACY_EXCEPTION_ENDPOINTS.edit, {
        exception_id: p.id,
        update_data: {
          name: p.rule_name,
          platform: p.platform,
          module: p.module,
          profile_ids: p.profile_ids ?? [],
          status: p.status,
          scope: p.scope,
          description: p.description,
          conditions: p.conditions,
        },
      })
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback restore failed: ${error}` }
    }
    if (deletable.length > 0) {
      const res = await client.call(LEGACY_EXCEPTION_ENDPOINTS.delete, {
        exception_ids: deletable.map((d) => d.createdId),
      })
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback delete failed: ${error}` }
    }
    return {
      success: true,
      message:
        `Rolled back legacy exceptions: ${restores.length} restored, ${deletable.length} deleted.` +
        (unrecoverable.length > 0
          ? ` ${unrecoverable.length} newly-created exception(s) could not be auto-deleted (add response did not return an exception id) — remove them manually via the console.`
          : ''),
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
