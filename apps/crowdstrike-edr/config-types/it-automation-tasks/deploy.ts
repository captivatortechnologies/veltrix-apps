import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import {
  createEntity,
  findEntityByIdentity,
  updateEntity,
  type EntityEndpoints,
} from '../../lib/entityAdapter'
import {
  buildTaskContent,
  extractITTaskSpecs,
  parseTaskParameters,
  type ITTaskSpec,
  type LiveITTask,
  type TaskParameter,
} from './validate'

/**
 * IT Automation Task API surface (verified against FalconPy `it_automation`).
 * query→get→create→update→delete match the generic entity adapter; identity is
 * `name`.
 */
export const IT_TASK_ENDPOINTS: EntityEndpoints = {
  entity: '/it-automation/entities/tasks/v1',
  queries: '/it-automation/queries/tasks/v1',
  identityField: 'name',
}

/** IT automation task fields this app manages and can restore on rollback. */
export interface ITTaskRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    description?: string
    task_type?: string
    os_query?: string
    remediations?: Record<string, { content?: string } | undefined>
    task_parameters?: Array<{ key?: string } & Record<string, unknown>>
  }
}

/**
 * Deploy IT automation tasks to a Falcon tenant via the Task API.
 *
 * For each declared task:
 *   - find it by its `name` identity (query → get, via the entity adapter)
 *   - if it exists, PATCH the managed fields (description, task_type, content,
 *     parameters)
 *   - otherwise POST a new task
 *
 * Content maps by task type: query → os_query, remediation →
 * remediations.<platform>.content for each declared platform.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractITTaskSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ITTaskRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { parameters, errors: parameterErrors } = parseTaskParameters(spec.parametersRaw)
      if (parameterErrors.length > 0) {
        throw new Error(`Task "${spec.name}": invalid parameters — ${parameterErrors[0]}`)
      }

      const existing = (await findEntityByIdentity(
        client,
        IT_TASK_ENDPOINTS,
        spec.name,
      )) as LiveITTask | null

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            description: existing.description ?? '',
            task_type: existing.task_type,
            os_query: existing.os_query,
            remediations: existing.remediations,
            task_parameters: existing.task_parameters,
          },
        })

        await updateEntity(client, IT_TASK_ENDPOINTS, {
          id: existing.id,
          name: spec.name,
          ...buildManagedTaskFields(spec, parameters),
        })
      } else {
        const id = await createEntity(client, IT_TASK_ENDPOINTS, {
          name: spec.name,
          ...buildManagedTaskFields(spec, parameters),
        })
        rollbackState.push({ name: spec.name, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} IT automation task(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedTasks: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `IT automation task deployment failed after ${deployed.length} of ${specs.length} task(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedTasks: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** The managed task fields written on create/update (name added by caller). */
export function buildManagedTaskFields(
  spec: ITTaskSpec,
  parameters: TaskParameter[],
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    description: spec.description ?? '',
    task_type: spec.taskType,
    ...buildTaskContent(spec),
  }
  if (parameters.length > 0) fields.task_parameters = parameters
  return fields
}
