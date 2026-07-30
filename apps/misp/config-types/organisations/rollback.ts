import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'
import type { MispOrganisation } from './_shared'

/**
 * Undo an organisations deploy from rollbackData.previous (written by deploy()):
 * for each entry with a prior body, POST /admin/organisations/edit/<id> to restore
 * it; a newly created organisation (prior body null) is left in place — org
 * deletion over this seam is destructive and skipped. Applied over the MISP REST
 * API (443). Verify /admin/organisations/edit/<id> against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; orgId: number | string | null; org: MispOrganisation | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for organisation rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let left = 0
  try {
    for (const { orgId, org } of previous) {
      if (orgId == null || !org) {
        // A newly created organisation (or one whose id we never learned) — leave it in place.
        left++
        continue
      }
      await sendJson('POST', `${base}/admin/organisations/edit/${encodeURIComponent(String(orgId))}`, headers, { Organisation: org })
      restored++
    }
    return { success: true, message: `Rolled back organisations: ${restored} restored${left ? `, ${left} left in place` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
