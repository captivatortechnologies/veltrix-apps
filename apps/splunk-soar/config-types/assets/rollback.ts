import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, sendJson, DELETE_AUTH_HINT } from '../../lib/soarApi'

/**
 * Undo an assets deploy from rollbackData.previous: a NEWLY CREATED asset
 * (existedBefore: false) is deleted via DELETE /rest/asset/<id> — safe
 * regardless of what its `configuration` held, since nothing about it was ever
 * captured. An asset that EXISTED before the deploy is intentionally left
 * as-is: `configuration` is write-only (see _shared.ts) and a full-replace
 * POST /<id> without the app-specific settings/credentials the live asset
 * already had would reset them to their defaults, per the endpoint's own
 * caution note — restoring would risk destroying live secrets this app never
 * saw. Update the asset manually in SOAR if the prior configuration is needed.
 * DELETE requires a user-authenticated credential (see lib/soarApi.ts).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; assetId: number | string | null; existedBefore: boolean }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: 'Missing credential for asset rollback' }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  let removed = 0
  let skipped = 0
  try {
    for (const { assetId, existedBefore } of previous) {
      if (assetId == null) continue
      if (existedBefore) {
        skipped++
        continue
      }
      await sendJson('DELETE', `${base}/rest/asset/${encodeURIComponent(String(assetId))}`, headers)
      removed++
    }
    const skippedNote = skipped
      ? ` ${skipped} updated asset(s) were NOT restored — their configuration is write-only and was never captured; update them manually in SOAR if needed.`
      : ''
    return { success: true, message: `Rolled back assets: ${removed} removed.${skippedNote}` }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, message: `Rollback failed: ${msg} — ${DELETE_AUTH_HINT}` }
  }
}
