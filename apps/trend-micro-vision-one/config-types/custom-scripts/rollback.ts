import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient, visionOneWriteError } from '../../lib/visionOneApi'
import { scriptItemPath, scriptUpdatePath } from './_shared'

/**
 * Undo a custom-script deploy from rollbackData.previous (written by deploy()):
 * scripts we UPDATED are RESTORED to their prior contents / type / description
 * (POST /response/customScripts/{id}/update); scripts we CREATED are DELETED
 * (DELETE /response/customScripts/{id}). Applied over the Trend Vision One public
 * REST API.
 *
 * VERIFY the update multipart body and the delete path against a live Vision One
 * tenant.
 */
interface ScriptRollbackEntry {
  fileName: string
  prior: { id: string; fileType: string; description: string; content: string } | null
  createdId: string | null
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: ScriptRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for custom-script rollback' }
  }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let restored = 0
  let removed = 0

  try {
    for (const entry of previous) {
      if (entry.prior) {
        // Restore the prior contents of a script we overwrote.
        const fields: Record<string, string> = { fileType: entry.prior.fileType }
        if (entry.prior.description) fields.description = entry.prior.description
        const res = await client.postMultipart(scriptUpdatePath(entry.prior.id), fields, {
          field: 'file',
          filename: entry.fileName,
          content: entry.prior.content,
        })
        const error = visionOneWriteError(res)
        if (error) return { success: false, message: `Rollback restore failed for ${entry.fileName}: ${error}` }
        restored++
      } else if (entry.createdId) {
        // Remove a script this deploy created.
        const res = await client.del(scriptItemPath(entry.createdId))
        const error = visionOneWriteError(res)
        if (error) return { success: false, message: `Rollback remove failed for ${entry.fileName}: ${error}` }
        removed++
      }
    }
    return {
      success: true,
      message: `Rolled back custom scripts: ${restored} restored, ${removed} removed.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
