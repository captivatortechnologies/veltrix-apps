import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient, visionOneWriteError } from '../../lib/visionOneApi'
import { EXCEPTION_ENDPOINTS, buildExceptionDeleteBody, type ExceptionObject } from './_shared'

/**
 * Undo an exception-list deploy from rollbackData.previous (written by deploy()):
 * objects that existed before are RESTORED by re-adding their prior body
 * (POST /threatintel/suspiciousObjectExceptions); objects this deploy CREATED
 * (prior null) are REMOVED (POST /threatintel/suspiciousObjectExceptions/delete
 * with their type-keyed value). Applied over the Trend Vision One public REST API.
 *
 * VERIFY the add + delete request bodies against a live Vision One tenant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ type: string; value: string; prior: ExceptionObject | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for exception-list rollback' }
  }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const restores = previous.filter((p) => p.prior).map((p) => p.prior as ExceptionObject)
  const deletes = previous
    .filter((p) => !p.prior)
    .map((p) => buildExceptionDeleteBody(p.type, p.value))
    .filter((b): b is ExceptionObject => b !== null)

  try {
    if (restores.length > 0) {
      const res = await client.post(EXCEPTION_ENDPOINTS.add, restores)
      const error = visionOneWriteError(res)
      if (error) return { success: false, message: `Rollback restore failed: ${error}` }
    }
    if (deletes.length > 0) {
      const res = await client.post(EXCEPTION_ENDPOINTS.delete, deletes)
      const error = visionOneWriteError(res)
      if (error) return { success: false, message: `Rollback remove failed: ${error}` }
    }
    return {
      success: true,
      message: `Rolled back exception objects: ${restores.length} restored, ${deletes.length} removed.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
