import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { connectFor, sendJson, groupResourcePath, upgradeQuery } from './_shared'

/**
 * Undo a Packs deploy from rollbackData.previous (written by deploy()): a
 * newly-INSTALLED pack (existed: false) is uninstalled (DELETE); a pack that
 * was UPGRADED (existed: true) is pinned back to its exact prior `version`
 * (PATCH .../packs/<id>?source=..&spec=<priorVersion>) so the rollback is a
 * reproducible downgrade rather than re-resolving the original loose spec.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ id: string; group: string; existed: boolean; priorSource: string | null; priorVersion: string | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: 'Missing credential for Packs rollback' }

  let downgraded = 0
  let uninstalled = 0
  let skipped = 0
  try {
    const { base, headers } = await connectFor({ component, credential, connectivity, connectivityProvider, settings })

    for (const { id, group, existed, priorSource, priorVersion } of previous) {
      if (!id) continue
      const url = `${groupResourcePath(base, group, 'packs')}/${encodeURIComponent(id)}`
      if (!existed) {
        await sendJson('DELETE', url, headers)
        uninstalled++
      } else if (priorVersion) {
        const query = upgradeQuery({ source: priorSource ?? undefined, spec: priorVersion })
        await sendJson('PATCH', `${url}${query}`, headers)
        downgraded++
      } else {
        skipped++
      }
    }
    const skippedNote = skipped ? ` ${skipped} pack(s) could not be pinned back (no prior version was captured) — left as-is.` : ''
    return { success: true, message: `Rolled back Packs: ${downgraded} downgraded, ${uninstalled} uninstalled.${skippedNote}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
