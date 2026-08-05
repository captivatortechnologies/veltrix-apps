import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCatoClient, responseError } from '../../lib/cato'
import { DELETE_CUSTOM_APPLICATION, UPDATE_CUSTOM_APPLICATION } from './_shared'
import { buildCustomApplicationInput } from './validate'
import type { CustomApplicationRollbackEntry } from './deploy'

/**
 * Roll back Custom Applications using the state captured during deploy:
 *   - created applications are deleted (deleteCustomApplication - ref by id)
 *   - updated applications are restored to their previous canvas spec
 *     (ctx.previousConfig, captured at deploy time - never a live re-read)
 * No publish step - Custom Applications apply immediately.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, accountId } = built

  const previousState = (ctx.rollbackData as { previousState?: CustomApplicationRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const restored: string[] = []
  const deleted: string[] = []
  const skipped: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql(DELETE_CUSTOM_APPLICATION, { accountId, input: { customApplication: { by: 'ID', input: entry.id } } })
          const err = responseError(res)
          if (err) throw new Error(`Failed to delete "${entry.name}": ${err}`)
          deleted.push(entry.name)
        }
      } else if (entry.id && entry.priorSpec) {
        const res = await client.graphql(UPDATE_CUSTOM_APPLICATION, {
          accountId,
          input: { ...buildCustomApplicationInput(entry.priorSpec), id: entry.id },
        })
        const err = responseError(res)
        if (err) throw new Error(`Failed to restore "${entry.name}": ${err}`)
        restored.push(entry.name)
      } else {
        skipped.push(entry.name)
      }
    }

    const skippedNote = skipped.length > 0 ? ` (${skipped.length} left unchanged - no prior canvas version captured: ${skipped.join(', ')})` : ''
    return { success: true, message: `Rolled back Custom Application(s): ${restored.length} restored, ${deleted.length} deleted${skippedNote}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
