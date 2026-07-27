import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import {
  createEntity,
  findEntityByIdentity,
  updateEntity,
  type EntityEndpoints,
} from '../../lib/entityAdapter'
import {
  extractScheduledTaskSpecs,
  parseSchedule,
  type LiveScheduledTask,
} from './validate'

/**
 * IT Automation Scheduled Task API surface (verified against FalconPy
 * `it_automation`). query→get→create→update→delete match the generic entity
 * adapter; the API identity is `task_id` (a scheduled task has no name).
 */
export const IT_SCHEDULED_TASK_ENDPOINTS: EntityEndpoints = {
  entity: '/it-automation/entities/scheduled-tasks/v1',
  queries: '/it-automation/queries/scheduled-tasks/v1',
  identityField: 'task_id',
}

/** Scheduled task fields this app manages and can restore on rollback. */
export interface ScheduledTaskRollbackEntry {
  name: string
  taskId: string
  existed: boolean
  id?: string
  prior?: {
    is_active?: boolean
    schedule?: Record<string, unknown>
  }
}

/**
 * Deploy scheduled tasks to a Falcon tenant via the Scheduled Task API.
 *
 * For each declared scheduled task:
 *   - find it by its `task_id` identity (query → get, via the entity adapter)
 *   - if it exists, PATCH the managed fields (is_active, schedule)
 *   - otherwise POST a new scheduled task
 *
 * Only task_id, is_active and the structured schedule are written. Host-group
 * targeting (the opaque `target` field) is intentionally NOT written — its shape
 * is unverified for this newer collection (see validate.ts) — so a live API that
 * requires a target will reject the create with a clear error here.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractScheduledTaskSpecs(ctx.canvas).filter((s) => s.taskId)
  const rollbackState: ScheduledTaskRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { schedule, errors: scheduleErrors } = parseSchedule(spec.scheduleRaw, spec.timezone)
      if (scheduleErrors.length > 0) {
        throw new Error(`Scheduled task "${spec.name}": invalid schedule — ${scheduleErrors[0]}`)
      }

      const existing = (await findEntityByIdentity(
        client,
        IT_SCHEDULED_TASK_ENDPOINTS,
        spec.taskId,
      )) as LiveScheduledTask | null

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          taskId: spec.taskId,
          existed: true,
          id: existing.id,
          prior: {
            is_active: existing.is_active,
            schedule: existing.schedule,
          },
        })

        const update: Record<string, unknown> = {
          id: existing.id,
          task_id: spec.taskId,
          is_active: spec.enabled,
        }
        if (schedule) update.schedule = schedule

        await updateEntity(client, IT_SCHEDULED_TASK_ENDPOINTS, update)
      } else {
        const create: Record<string, unknown> = {
          task_id: spec.taskId,
          is_active: spec.enabled,
        }
        if (schedule) create.schedule = schedule

        const id = await createEntity(client, IT_SCHEDULED_TASK_ENDPOINTS, create)
        rollbackState.push({ name: spec.name, taskId: spec.taskId, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} scheduled task(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedScheduledTasks: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scheduled task deployment failed after ${deployed.length} of ${specs.length} scheduled task(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedScheduledTasks: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}
