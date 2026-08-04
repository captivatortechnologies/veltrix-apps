import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, sendJson, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import type { OwnershipTypeRollbackEntry, RunzeroOwnershipType } from './_shared'

/**
 * Undo an asset-ownership-types deploy from rollbackData.previous (written by deploy), using the
 * same BATCH endpoints as deploy:
 *   - types that were CREATED (existed:false) are deleted in one batch call
 *     (DELETE /account/assets/ownership-types, body: array of ids)
 *   - types that were UPDATED (existed:true) are restored to their prior body in one batch call
 *     (PUT /account/assets/ownership-types, body: array of prior AssetOwnershipType objects)
 * Applied over the runZero console REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: OwnershipTypeRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveRunzeroToken(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const timeoutMs = timeoutFrom(settings)

  const idsToDelete: string[] = []
  const toRestore: RunzeroOwnershipType[] = []
  let left = 0

  for (const entry of previous) {
    if (!entry.typeId) {
      left++
      continue
    }
    if (!entry.existed) {
      idsToDelete.push(entry.typeId)
    } else if (entry.prior) {
      toRestore.push(entry.prior)
    } else {
      left++
    }
  }

  try {
    if (idsToDelete.length > 0) {
      await sendJson('DELETE', `${base}/account/assets/ownership-types`, headers, idsToDelete, timeoutMs)
    }
    if (toRestore.length > 0) {
      await sendJson('PUT', `${base}/account/assets/ownership-types`, headers, toRestore, timeoutMs)
    }
    return {
      success: true,
      message: `Rolled back asset ownership types: ${toRestore.length} restored, ${idsToDelete.length} deleted${left ? `, ${left} left in place` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

function timeoutFrom(settings: Record<string, unknown>): number | undefined {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined
}
