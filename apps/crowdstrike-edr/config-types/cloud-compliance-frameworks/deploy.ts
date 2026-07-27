import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import {
  createFramework,
  findFrameworkByName,
  frameworkId,
  updateFramework,
} from './frameworkApi'
import { extractFrameworkSpecs } from './validate'

/** Framework fields this app manages and can restore on rollback. */
export interface FrameworkRollbackEntry {
  name: string
  existed: boolean
  uuid?: string
  prior?: {
    description?: string
    active: boolean
  }
}

/**
 * Deploy custom compliance frameworks to a Falcon tenant via the Cloud Security
 * Policies API.
 *
 * For each declared framework:
 *   - find it by its `name` identity
 *   - if it exists, PATCH the managed fields (name, description, active)
 *   - otherwise POST a new framework (active)
 *
 * A framework's sections are realized through its controls (managed by the
 * cloud-compliance-controls config type), and Falcon assigns the version, so
 * only name/description/active are written here. Prior state is captured so
 * rollback can revert updates and delete anything this deploy created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractFrameworkSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: FrameworkRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findFrameworkByName(client, spec.name)
      const uuid = frameworkId(existing)

      if (existing && uuid) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          uuid,
          prior: {
            description: typeof existing.description === 'string' ? existing.description : undefined,
            active: existing.active === true,
          },
        })
        await updateFramework(client, uuid, {
          name: spec.name,
          description: spec.description,
          active: true,
        })
      } else {
        const newUuid = await createFramework(client, {
          name: spec.name,
          description: spec.description,
          active: true,
        })
        rollbackState.push({ name: spec.name, existed: false, uuid: newUuid })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} compliance framework(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedFrameworks: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Compliance framework deployment failed after ${deployed.length} of ${specs.length} framework(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedFrameworks: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}
