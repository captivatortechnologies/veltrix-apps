import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient, semgrepWriteError } from '../../lib/semgrepApi'
import type { ManagedScanRollbackEntry } from './deploy'

/**
 * Undo a Managed Scan deploy from rollbackData.previous (written by deploy()):
 * per project, PATCH the Managed Scans config back to the prior full_scan /
 * diff_scan enabled flags. A project that can no longer be written is reported.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: ManagedScanRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for Managed Scan rollback' }
  }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasSlug) {
    return { success: false, message: 'No Semgrep deployment slug set — configure the "Deployment Slug" app setting.' }
  }

  const restored: string[] = []

  try {
    for (const entry of previous) {
      const res = await client.updateManagedScan(entry.projectName, {
        full_scan: { enabled: entry.priorFullScan },
        diff_scan: { enabled: entry.priorDiffScan },
      })
      const err = semgrepWriteError(res)
      if (err) return { success: false, message: `Rollback failed for "${entry.projectName}": ${err}` }
      restored.push(entry.projectName)
    }

    return { success: true, message: `Rolled back Managed Scans for ${restored.length} project(s): ${restored.join(', ') || '(none)'}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
