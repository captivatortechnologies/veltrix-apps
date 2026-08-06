import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient } from '../../lib/kandjiApi'
import { buildTagBody, type LiveTag } from './validate'
import type { TagRollbackEntry } from './deploy'

const TAGS_PATH = '/api/v1/tags'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TagRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${TAGS_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete tag "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PATCH', `${TAGS_PATH}/${encodeURIComponent(entry.id)}`, {
          body: priorToBody(entry.prior),
        })
        if (res.error) throw new Error(`Failed to restore tag "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }
    return { success: true, message: `Rolled back ${reverted.length} Kandji tag(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

function priorToBody(prior: LiveTag): Record<string, unknown> {
  return buildTagBody({ sectionName: '', name: prior.name ?? '' })
}
