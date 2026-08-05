import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, restResult, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import {
  buildAttributesBody,
  extractProjectAttributesSpecs,
  tagsArrayToRecord,
  type LiveProject,
  type ProjectAttributesSpec,
} from './validate'

export interface ProjectAttributesRollbackEntry {
  projectId: string
  prior: {
    businessCriticality: string[]
    environment: string[]
    lifecycle: string[]
    tags: Record<string, string>
    testFrequency: string
    ownerUserId: string
  }
}

/**
 * Deploy Snyk project attributes via the REST API.
 *
 * Projects must already exist in Snyk — this config type UPDATES an existing
 * project's classification metadata; it never creates or deletes one. Identity
 * is the project id: GET the project (captured for rollback), then PATCH the
 * managed attributes. The owner relationship is included on the request only
 * when the operator declared one, so an unmanaged owner is never touched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — configure the "Organization ID" app setting.' }
  }

  const specs = extractProjectAttributesSpecs(ctx.canvas).filter((s) => s.projectId)
  const rollbackState: ProjectAttributesRollbackEntry[] = []
  const updated: string[] = []

  try {
    for (const spec of specs) {
      const live = await readProject(client, spec.projectId)
      const priorAttrs = live.attributes ?? {}
      rollbackState.push({
        projectId: spec.projectId,
        prior: {
          businessCriticality: priorAttrs.business_criticality ?? [],
          environment: priorAttrs.environment ?? [],
          lifecycle: priorAttrs.lifecycle ?? [],
          tags: tagsArrayToRecord(priorAttrs.tags),
          testFrequency: priorAttrs.settings?.recurring_tests?.frequency ?? '',
          ownerUserId: live.relationships?.owner?.data?.id ?? '',
        },
      })

      const res = await client.rest('PATCH', `${client.restOrgPath()}/projects/${spec.projectId}`, {
        body: {
          data: {
            id: spec.projectId,
            type: 'project',
            attributes: buildAttributesBody(spec),
            relationships: buildOwnerRelationship(spec),
          },
        },
      })
      if (!res.ok) throw new Error(`Failed to update project "${spec.projectId}": ${snykErrorMessage(res)}`)
      updated.push(spec.projectId)
    }

    return {
      success: true,
      message: `Snyk project attributes deployed to ${host}: ${updated.length} updated`,
      artifacts: { host, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Project attributes deployment failed after ${updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** `relationships` for the PATCH body — the `owner` key is present ONLY when the operator set one. */
export function buildOwnerRelationship(spec: Pick<ProjectAttributesSpec, 'ownerUserId'>): Record<string, unknown> {
  return spec.ownerUserId ? { owner: { data: { id: spec.ownerUserId, type: 'user' } } } : {}
}

/** GET a project by id; throws on a non-OK response or a missing `data` payload (the project does not exist). */
export async function readProject(client: SnykClient, projectId: string): Promise<LiveProject> {
  const res = await client.rest('GET', `${client.restOrgPath()}/projects/${projectId}`)
  if (!res.ok) {
    throw new Error(`Failed to read project "${projectId}": ${snykErrorMessage(res)}`)
  }
  const data = restResult<LiveProject>(res)
  if (!data) {
    throw new Error(`Project "${projectId}" was not found — this config type only updates an existing project`)
  }
  return data
}
