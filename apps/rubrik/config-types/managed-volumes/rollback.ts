import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'
import { buildManagedVolumePatchBody, managedVolumeToFields, type RubrikManagedVolume } from './_shared'

interface RollbackEntry {
  name: string
  existed: boolean
  id: string | null
  prior: RubrikManagedVolume | null
}

/**
 * Undo a managed-volumes deploy from rollbackData.previous (written by deploy()):
 *   - an MV we CREATED (existed=false): DELETE /api/internal/managed_volume/{id}
 *   - an MV we UPDATED (existed=true):  PATCH  /api/internal/managed_volume/{id} with the prior mutable subset
 * A created MV we delete carries no snapshots yet, so preserve_snapshots=false fully
 * removes it. An entry whose id we never learned is skipped (nothing safe to undo).
 * Applied over the Rubrik CDM internal REST API. FLAG: verify against a live cluster.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveServiceAccount(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch (error) {
    return { success: false, message: `Rubrik connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.id) {
        skipped++
        continue
      }
      const base = `/api/internal/managed_volume/${encodeURIComponent(entry.id)}`
      if (entry.existed && entry.prior) {
        await sendJson(conn, 'PATCH', base, buildManagedVolumePatchBody(managedVolumeToFields(entry.prior)))
        restored++
      } else {
        await sendJson(conn, 'DELETE', `${base}?preserve_snapshots=false`)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back managed volumes: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
