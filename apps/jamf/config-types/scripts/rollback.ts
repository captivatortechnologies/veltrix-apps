import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { PARAMETER_KEYS, type LiveScript } from './validate'
import type { ScriptRollbackEntry } from './deploy'

const SCRIPTS_PATH = '/v1/scripts'

/**
 * Roll back Jamf Pro scripts using the state captured during deploy:
 *   - scripts that were created are deleted (DELETE /v1/scripts/{id})
 *   - scripts that were updated are restored to their captured prior full
 *     state (PUT /v1/scripts/{id})
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScriptRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${SCRIPTS_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete script "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PUT', `${SCRIPTS_PATH}/${encodeURIComponent(entry.id)}`, priorToBody(entry.prior))
        if (res.error) throw new Error(`Failed to restore script "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Jamf Pro script(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild an update body from a captured prior script state. */
function priorToBody(prior: LiveScript): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: prior.name ?? '',
    info: prior.info ?? '',
    notes: prior.notes ?? '',
    priority: prior.priority ?? 'AFTER',
    osRequirements: prior.osRequirements ?? '',
    scriptContents: prior.scriptContents ?? '',
  }
  if (prior.categoryName) body.categoryName = prior.categoryName
  for (const key of PARAMETER_KEYS) body[key] = prior[key] ?? ''
  return body
}
