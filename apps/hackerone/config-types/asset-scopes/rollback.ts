import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError } from '../../lib/hackeroneApi'
import { updateAssetScopeBody, archiveAssetScopeBody, type AssetScopeAttributes } from './_shared'

/**
 * Undo an asset-scope deploy from rollbackData.previous (written by deploy()):
 *   - an attachment that ALREADY EXISTED → PUT its prior eligibility/instruction
 *     back (restoring `notify_subscribers_of_changes` to `false` — its prior
 *     value was never read back from HackerOne, which does not return it).
 *   - an attachment this deploy CREATED   → archive it via the bulk archive
 *     endpoint, keyed by PROGRAM id (HackerOne exposes no per-scope-id DELETE
 *     here — see ./_shared).
 */
interface RollbackEntry {
  organizationHandle: string
  organizationId: string | null
  programHandle: string
  programId: string | null
  assetIdentifier: string
  assetId: string | null
  scopeId: string | null
  existed: boolean
  previousAttributes: Partial<AssetScopeAttributes> | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for asset-scope rollback' }
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
    const label = `${entry.organizationHandle}/${entry.programHandle}/${entry.assetIdentifier}`
    try {
      if (entry.existed && entry.previousAttributes && entry.scopeId) {
        const res = await client.put(
          `/organizations/${encodeURIComponent(entry.organizationId)}/assets/${encodeURIComponent(entry.assetId)}/scopes/${encodeURIComponent(entry.scopeId)}`,
          updateAssetScopeBody(
            {
              eligible_for_submission: Boolean(entry.previousAttributes.eligible_for_submission),
              eligible_for_bounty: Boolean(entry.previousAttributes.eligible_for_bounty),
              instruction: entry.previousAttributes.instruction ?? null,
            },
            false,
          ),
        )
        const error = hackeroneWriteError(res)
        if (error) {
          failures.push(`restore "${label}": ${error}`)
          continue
        }
        restored++
      } else if (entry.programId) {
        const res = await client.post(
          `/organizations/${encodeURIComponent(entry.organizationId)}/assets/${encodeURIComponent(entry.assetId)}/scopes/archive`,
          archiveAssetScopeBody([entry.programId]),
        )
        const error = hackeroneWriteError(res)
        if (error) {
          failures.push(`archive "${label}": ${error}`)
          continue
        }
        archived++
      } else {
        skipped++
      }
    } catch (error) {
      failures.push(`"${label}": ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  const summary = `${restored} restored, ${archived} archived${skipped ? `, ${skipped} skipped` : ''}`
  if (failures.length > 0) {
    return { success: false, message: `Asset-scope rollback (${summary}); ${failures.length} error(s): ${failures.join('; ')}.` }
  }
  return { success: true, message: `Rolled back asset scopes: ${summary}.` }
}
