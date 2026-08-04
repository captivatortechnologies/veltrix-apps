import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { buildDepartmentBody, type LiveDepartment } from './validate'
import type { DepartmentRollbackEntry } from './deploy'

const DEPARTMENTS_PATH = '/v1/departments'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DepartmentRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${DEPARTMENTS_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete department "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PUT', `${DEPARTMENTS_PATH}/${encodeURIComponent(entry.id)}`, priorToBody(entry.prior))
        if (res.error) throw new Error(`Failed to restore department "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }
    return { success: true, message: `Rolled back ${reverted.length} Jamf Pro department(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

function priorToBody(prior: LiveDepartment): Record<string, unknown> {
  return buildDepartmentBody({ sectionName: '', name: prior.name ?? '' })
}
