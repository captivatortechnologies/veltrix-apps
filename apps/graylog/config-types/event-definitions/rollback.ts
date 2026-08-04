import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveEventDefinition, type GraylogEventDefinition } from './_shared'

/**
 * Undo an event-definitions deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /api/events/definitions/{id} with the prior
 * definition (restore — the prior `state` is preserved so an enabled
 * definition stays enabled), or — when the definition was newly created (prior
 * null) — DELETE /api/events/definitions/{id} to remove it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ title: string; definitionId: string | null; definition: GraylogEventDefinition | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for event-definition rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { definitionId, definition } of previous) {
      if (!definitionId) {
        skipped++
        continue
      }
      const schedule = definition?.state === 'ENABLED'
      const path = `${base}/api/events/definitions/${encodeURIComponent(definitionId)}?schedule=${schedule}`
      if (definition) {
        await sendJson('PUT', path, headers, bodyFromLiveEventDefinition(definition))
        restored++
      } else {
        await sendJson('DELETE', `${base}/api/events/definitions/${encodeURIComponent(definitionId)}`, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back event definitions: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
