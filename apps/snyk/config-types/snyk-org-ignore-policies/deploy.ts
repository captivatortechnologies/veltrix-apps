import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, restResult, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import { buildConditionsGroup, buildIgnoreAction, extractPolicySpecs, policyKey, type LivePolicy } from './validate'

export interface PolicyRollbackEntry {
  key: string
  name: string
  existed: boolean
  /** Id of the live policy (set for both created and updated policies). */
  id?: string
  /** Prior attributes, captured before an update (never set for a create). */
  prior?: { name?: string; conditionsGroup?: unknown; action?: unknown }
}

/**
 * Deploy Snyk org-level ignore policies via the REST (JSON:API) API.
 *
 * Identity is the policy name: list /orgs/{org_id}/policies, match on the name,
 * then PATCH an existing policy's name/conditions/action or POST a new one.
 * Requires Code Consistent Ignores enabled for the org — Snyk returns 403
 * otherwise, surfaced here via snykErrorMessage rather than special-cased.
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

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name && s.findingKey)
  const rollbackState: PolicyRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listPolicies(client)
    const byName = new Map(existing.filter((p) => p.attributes?.name).map((p) => [policyKey(p.attributes!.name as string), p]))

    for (const spec of specs) {
      const key = policyKey(spec.name)
      const live = byName.get(key)
      const conditionsGroup = buildConditionsGroup(spec.findingKey)
      const action = buildIgnoreAction(spec)

      if (live && live.id) {
        rollbackState.push({
          key,
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: live.attributes?.name,
            conditionsGroup: live.attributes?.conditions_group,
            action: live.attributes?.action,
          },
        })
        const res = await client.rest('PATCH', `${client.restOrgPath()}/policies/${live.id}`, {
          body: {
            data: {
              id: live.id,
              type: 'policy',
              attributes: { name: spec.name, conditions_group: conditionsGroup, action },
            },
          },
        })
        if (!res.ok) throw new Error(`Failed to update ignore policy "${spec.name}": ${snykErrorMessage(res)}`)
        updated.push(spec.name)
      } else {
        const res = await client.rest('POST', `${client.restOrgPath()}/policies`, {
          body: {
            data: {
              type: 'policy',
              attributes: { name: spec.name, conditions_group: conditionsGroup, action, action_type: 'ignore' },
            },
          },
        })
        if (!res.ok) throw new Error(`Failed to create ignore policy "${spec.name}": ${snykErrorMessage(res)}`)
        const createdPolicy = restResult<{ id?: string }>(res)
        rollbackState.push({ key, name: spec.name, existed: false, id: createdPolicy?.id })
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `Snyk org-level ignore policies deployed to ${host}: ${created.length} created, ${updated.length} updated`,
      artifacts: { host, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Ignore-policy deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List all org-level policies; throws on a non-OK response (e.g. 403 when Code Consistent Ignores is not enabled). */
export async function listPolicies(client: SnykClient): Promise<LivePolicy[]> {
  const res = await client.restGetAll<LivePolicy>(`${client.restOrgPath()}/policies`)
  if (!res.ok) {
    throw new Error(`Failed to list org-level ignore policies: ${snykErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
