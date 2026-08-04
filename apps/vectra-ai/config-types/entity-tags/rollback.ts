import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, sendJson } from '../../lib/vectraApi'
import { taggingPath } from './_shared'

/**
 * Undo an entity-tags deploy from rollbackData.previous (written by deploy()): PATCH
 * each entity's prior tags back. An entity whose prior tags couldn't be read (null)
 * is skipped rather than guessed. Applied over the Vectra Detect REST API (v2.5, 443).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ entityType: string; entityId: string; tags: string[] | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for entity tags rollback' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let skipped = 0
  try {
    for (const { entityType, entityId, tags } of previous) {
      if (tags == null) {
        skipped++
        continue
      }
      await sendJson('PATCH', `${base}${taggingPath(entityType, entityId)}`, headers, { tags })
      restored++
    }
    return { success: true, message: `Rolled back entity tags: ${restored} restored${skipped ? `, ${skipped} skipped` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
