import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'
import type { MispGalaxy } from './_shared'

/**
 * Undo a galaxies deploy from rollbackData.previous (written by deploy()): for each
 * entry with a prior body, POST /galaxies/edit/<id> to restore it plus
 * /galaxies/enable|disable/<id> to restore its prior enabled state; a newly created
 * galaxy (prior body null) is deleted via POST /galaxies/delete/<id>. Applied over
 * the MISP REST API (443). Verify /galaxies/edit/<id> + /galaxies/delete/<id>
 * against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ type: string; galaxyId: number | string | null; galaxy: MispGalaxy | null; enabledBefore: boolean | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for galaxy rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { galaxyId, galaxy, enabledBefore } of previous) {
      if (galaxyId == null) continue // never learned an id — nothing addressable to undo
      if (galaxy) {
        await sendJson('POST', `${base}/galaxies/edit/${encodeURIComponent(String(galaxyId))}`, headers, { Galaxy: galaxy })
        if (enabledBefore !== null) {
          await sendJson('POST', `${base}/galaxies/${enabledBefore ? 'enable' : 'disable'}/${encodeURIComponent(String(galaxyId))}`, headers, {})
        }
        restored++
      } else {
        await sendJson('POST', `${base}/galaxies/delete/${encodeURIComponent(String(galaxyId))}`, headers, {})
        deleted++
      }
    }
    return { success: true, message: `Rolled back galaxies: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
