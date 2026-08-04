import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildRecordedFutureClient } from '../../lib/recordedFutureApi'
import { fusionErrorMessage, fusionPaths } from './_shared'

/**
 * Undo a Fusion File deploy from rollbackData.previous (written by deploy()):
 *   - a file this deploy CREATED (did not exist before) is DELETED
 *     (DELETE /fusion/v3/files/{path});
 *   - a file this deploy OVERWROTE is restored to its exact PRIOR content
 *     (POST /fusion/v3/files/{path} with the captured bytes).
 * Entries this deploy left unchanged (skipped — content already matched) are
 * left alone.
 *
 * VERIFY the Fusion Files delete/upload semantics against a live account.
 */
interface RollbackEntry {
  path: string
  existed: boolean
  priorContent: string | null
  changed: boolean
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings, component } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for Fusion File rollback' }
  }

  const built = buildRecordedFutureClient(credential, settings, component?.hostname)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let deleted = 0
  let restored = 0
  const failures: string[] = []

  for (const entry of previous) {
    if (!entry.changed) continue

    try {
      if (entry.existed) {
        const res = await client.raw('POST', fusionPaths.file(entry.path), { body: entry.priorContent ?? '' })
        if (!res.ok) {
          failures.push(`restore "${entry.path}": ${fusionErrorMessage(res.status, res.body)}`)
          continue
        }
        restored++
      } else {
        const res = await client.raw('DELETE', fusionPaths.file(entry.path))
        if (!res.ok && res.status !== 404) {
          failures.push(`delete "${entry.path}": ${fusionErrorMessage(res.status, res.body)}`)
          continue
        }
        deleted++
      }
    } catch (error) {
      failures.push(`"${entry.path}": ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Rollback restored ${restored} file(s) and deleted ${deleted}; ${failures.length} error(s): ${failures.join('; ')}.`,
    }
  }

  return { success: true, message: `Rolled back Fusion Files: ${restored} restored, ${deleted} deleted.` }
}
