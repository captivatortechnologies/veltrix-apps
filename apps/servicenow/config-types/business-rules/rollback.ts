import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildServiceNowClient, serviceNowErrorMessage } from '../../lib/servicenowApi'
import { SYS_SCRIPT_TABLE } from './_shared'

/**
 * Undo a business-rules deploy from rollbackData.previous (written by deploy()):
 *   - a rule we CREATED (prior record null): DELETE /table/sys_script/<sys_id>
 *   - a rule we UPDATED (prior record present): PATCH the prior managed field
 *     values back by sys_id
 * A created rule whose sys_id we never learned is skipped (nothing safe to undo).
 * Applied over the Table API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; collection: string; sysId: string | null; record: Record<string, unknown> | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildServiceNowClient(component?.hostname, credential, settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { sysId, record } of previous) {
      if (!sysId) {
        skipped++
        continue
      }
      if (record) {
        const res = await client.update(SYS_SCRIPT_TABLE, sysId, record)
        if (!res.ok) {
          throw new Error(`Restore of ${sysId} failed (HTTP ${res.status}): ${serviceNowErrorMessage(res)}`)
        }
        restored++
      } else {
        const res = await client.remove(SYS_SCRIPT_TABLE, sysId)
        // 404 = already gone; treat as deleted rather than an error.
        if (!res.ok && res.status !== 404) {
          throw new Error(`Delete of ${sysId} failed (HTTP ${res.status}): ${serviceNowErrorMessage(res)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back business rules: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
