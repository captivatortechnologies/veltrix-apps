import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError } from '../../lib/cortexXdrApi'
import { PREVENTION_PROFILE_ENDPOINTS, type LivePreventionProfile } from './_shared'

/**
 * Undo a prevention-profile deploy from rollbackData.previous (written by
 * deploy()): profiles that existed before are RESTORED via
 * /profiles/prevention/edit/ with their prior name/description/modules.
 *
 * Cortex XDR documents NO delete endpoint for prevention profiles — a profile
 * this deploy CREATED (prior null) CANNOT be programmatically removed. This
 * mirrors the Hash Exceptions type's add-only honesty: rollback reports what it
 * could not undo rather than silently pretending success.
 *
 * VERIFY the edit request envelope (RAW body, no `{ request_data }` wrapper —
 * see _shared.ts) against a live Cortex XDR tenant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; prior: LivePreventionProfile | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for prevention-profile rollback' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const restores = previous.filter((p) => p.prior)
  const uncreatable = previous.filter((p) => !p.prior)

  try {
    for (const { prior } of restores) {
      const p = prior as LivePreventionProfile
      if (p.is_default) continue // Cortex XDR does not allow editing default profiles — nothing to restore
      const res = await client.post(PREVENTION_PROFILE_ENDPOINTS.edit, {
        profile_id: p.id,
        update_data: { name: p.name, description: p.description ?? '', modules: p.modules ?? {} },
      })
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback restore failed: ${error}` }
    }
    return {
      success: true,
      message:
        `Rolled back prevention profiles: ${restores.length} restored.` +
        (uncreatable.length > 0
          ? ` ${uncreatable.length} newly-created profile(s) could not be removed — Cortex XDR documents no delete endpoint for prevention profiles; remove them manually via the console.`
          : ''),
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
