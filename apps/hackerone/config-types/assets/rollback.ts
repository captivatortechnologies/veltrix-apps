import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError } from '../../lib/hackeroneApi'
import { assetWriteBody, archiveAssetsBody, type AssetUpdateAttributes } from './_shared'

/**
 * Undo an asset deploy from rollbackData.previous (written by deploy()):
 *   - an asset that ALREADY EXISTED → PUT its prior (update-shape) attributes back.
 *   - an asset this deploy CREATED   → archive it via the bulk archive endpoint
 *     (HackerOne exposes no per-id DELETE for assets), removing it from the
 *     organization's active inventory.
 */
interface RollbackEntry {
  organizationHandle: string
  organizationId: string | null
  identifier: string
  assetId: string | null
  existed: boolean
  previousAttributes: Partial<AssetUpdateAttributes> | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for asset rollback' }
  }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let restored = 0
  let archived = 0
  let skipped = 0
  const failures: string[] = []

  for (const entry of previous) {
    if (!entry.organizationId || !entry.assetId) {
      skipped++
      continue
    }
    try {
      if (entry.existed && entry.previousAttributes) {
        const res = await client.put(
          `/organizations/${encodeURIComponent(entry.organizationId)}/assets/${encodeURIComponent(entry.assetId)}`,
          assetWriteBody(entry.previousAttributes),
        )
        const error = hackeroneWriteError(res)
        if (error) {
          failures.push(`restore "${entry.identifier}" (${entry.organizationHandle}): ${error}`)
          continue
        }
        restored++
      } else {
        const res = await client.post(
          `/organizations/${encodeURIComponent(entry.organizationId)}/assets/archive`,
          archiveAssetsBody([entry.assetId]),
        )
        const error = hackeroneWriteError(res)
        if (error) {
          failures.push(`archive "${entry.identifier}" (${entry.organizationHandle}): ${error}`)
          continue
        }
        archived++
      }
    } catch (error) {
      failures.push(`"${entry.identifier}" (${entry.organizationHandle}): ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  const summary = `${restored} restored, ${archived} archived${skipped ? `, ${skipped} skipped` : ''}`
  if (failures.length > 0) {
    return { success: false, message: `Asset rollback (${summary}); ${failures.length} error(s): ${failures.join('; ')}.` }
  }
  return { success: true, message: `Rolled back assets: ${summary}.` }
}
