import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet, type FalconClient } from '../../lib/falcon'
import {
  controlId,
  createControl,
  findControl,
  readAssignedRuleIds,
  replaceControlRules,
  resolveFrameworkName,
  ruleReadCoords,
  updateControl,
} from './controlApi'
import { extractControlSpecs } from './validate'

/** Control state this app manages and can restore on rollback. */
export interface ControlRollbackEntry {
  name: string
  frameworkId: string
  section: string
  existed: boolean
  uuid?: string
  prior?: {
    description?: string
    ruleIds: string[]
  }
}

/**
 * Deploy custom compliance controls to a Falcon tenant via the Cloud Security
 * Policies API.
 *
 * For each declared control:
 *   - resolve its parent framework (by uuid) — it must already exist
 *   - find the control by name within that framework + section
 *   - if it exists, PATCH the mutable fields (name, description)
 *   - otherwise POST a new control (framework_id, name, section_name, description)
 *   - converge its rule assignments to exactly the declared set
 *
 * Section and parent framework are immutable after creation. Prior state
 * (description + assigned rule IDs) is captured so rollback can restore updates
 * and delete anything this deploy created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractControlSpecs(ctx.canvas).filter((s) => s.name && s.frameworkId && s.section)
  const rollbackState: ControlRollbackEntry[] = []
  const deployed: string[] = []
  const frameworkNames = new Map<string, string>()

  try {
    for (const spec of specs) {
      const frameworkName = await resolveFrameworkNameCached(client, frameworkNames, spec.frameworkId)
      if (!frameworkName) {
        throw new Error(
          `Parent framework "${spec.frameworkId}" for control "${spec.name}" does not exist in the tenant`,
        )
      }

      const existing = await findControl(client, {
        name: spec.name,
        frameworkId: spec.frameworkId,
        section: spec.section,
      })

      let uuid: string
      let priorRuleIds: string[]

      if (existing && controlId(existing)) {
        uuid = controlId(existing) as string
        priorRuleIds = await readAssignedRuleIds(client, ruleReadCoords(existing))
        rollbackState.push({
          name: spec.name,
          frameworkId: spec.frameworkId,
          section: spec.section,
          existed: true,
          uuid,
          prior: {
            description: typeof existing.description === 'string' ? existing.description : undefined,
            ruleIds: priorRuleIds,
          },
        })
        await updateControl(client, uuid, { name: spec.name, description: spec.description })
      } else {
        uuid = await createControl(client, {
          frameworkId: spec.frameworkId,
          name: spec.name,
          section: spec.section,
          description: spec.description,
        })
        priorRuleIds = []
        rollbackState.push({
          name: spec.name,
          frameworkId: spec.frameworkId,
          section: spec.section,
          existed: false,
          uuid,
          prior: { description: undefined, ruleIds: [] },
        })
      }

      // Converge rule assignments to exactly the declared set.
      if (!sameSet(priorRuleIds, spec.ruleIds)) {
        await replaceControlRules(client, uuid, spec.ruleIds)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} compliance control(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedControls: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Compliance control deployment failed after ${deployed.length} of ${specs.length} control(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedControls: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Resolve a framework name once per uuid within a deploy. */
async function resolveFrameworkNameCached(
  client: FalconClient,
  cache: Map<string, string>,
  frameworkUuid: string,
): Promise<string | null> {
  const cached = cache.get(frameworkUuid)
  if (cached) return cached
  const name = await resolveFrameworkName(client, frameworkUuid)
  if (name) cache.set(frameworkUuid, name)
  return name
}
