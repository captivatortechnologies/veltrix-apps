import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient } from '../../lib/kandjiApi'
import { buildBlueprintUpdateBody, type BlueprintSpec, type LiveBlueprint } from './validate'
import type { BlueprintRollbackEntry } from './deploy'

const BLUEPRINTS_PATH = '/api/v1/blueprints'

/**
 * Roll back Blueprints using the state captured during deploy:
 *   - Blueprints this deploy CREATED are deleted (DELETE .../blueprints/{id})
 *   - Blueprints this deploy UPDATED are restored to their prior fields (PATCH)
 *
 * Deleting a created Blueprint is destructive — Kandji un-manages every
 * device currently assigned to it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: BlueprintRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${BLUEPRINTS_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete Blueprint "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.requestUrlEncoded(
          'PATCH',
          `${BLUEPRINTS_PATH}/${encodeURIComponent(entry.id)}`,
          priorToUpdateBody(entry.prior),
        )
        if (res.error) throw new Error(`Failed to restore Blueprint "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }
    return { success: true, message: `Rolled back ${reverted.length} Kandji Blueprint(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

function priorToUpdateBody(prior: LiveBlueprint): Record<string, string> {
  const spec: BlueprintSpec = {
    sectionName: '',
    name: prior.name ?? '',
    description: prior.description ?? '',
    type: prior.type ?? 'classic',
    icon: prior.icon ?? '',
    color: prior.color ?? '',
    enrollmentActive: prior.enrollment_code?.is_active ?? true,
    enrollmentCode: prior.enrollment_code?.code ?? '',
  }
  return buildBlueprintUpdateBody(spec)
}
