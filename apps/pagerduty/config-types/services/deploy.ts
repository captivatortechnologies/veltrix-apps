import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import {
  buildServiceBody,
  extractServiceSpecs,
  findPolicyId,
  type LiveService,
} from './_shared'

/** Per-service rollback record captured during deploy. */
export interface ServiceRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: LiveService
}

/**
 * Deploy PagerDuty services over the REST API v2:
 *   read (rollback): GET  /services            → find each live service by name
 *   resolve ref:     GET  /escalation_policies  → escalation policy NAME → id
 *   create:          POST /services             with { service: {...} }
 *   update:          PUT  /services/{id}         with { service: {...} }
 *
 * The name is the stable identity used to upsert. Each service references an
 * escalation policy by name, resolved to an escalation_policy_reference here.
 * rollbackData records, per service, whether it existed and its prior body — so
 * rollback can restore an updated service or delete a newly created one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractServiceSpecs(ctx.canvas).filter((s) => s.name && s.escalationPolicyName)
  const rollbackState: ServiceRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listServices(client)
    const byName = new Map(existing.filter((s) => s.name).map((s) => [String(s.name).toLowerCase(), s]))
    const policies = await listEscalationPolicies(client)

    for (const spec of specs) {
      const epId = findPolicyId(policies, spec.escalationPolicyName)
      if (!epId) {
        throw new Error(
          `Service "${spec.name}" references escalation policy "${spec.escalationPolicyName}" which was not found in the account`,
        )
      }
      const body = { service: buildServiceBody(spec, epId) }
      const live = byName.get(spec.name.toLowerCase())

      if (live && live.id) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/services/${encodeURIComponent(live.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to update service "${spec.name}": ${pagerDutyErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/services', { body })
        if (!res.ok) throw new Error(`Failed to create service "${spec.name}": ${pagerDutyErrorMessage(res)}`)
        const created = parseJson<{ service?: LiveService }>(res.body)?.service
        if (!created?.id) throw new Error(`Service "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} service(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Service deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all services in the account; throws on a non-OK response. */
export async function listServices(client: PagerDutyClient): Promise<LiveService[]> {
  const res = await client.getAll<LiveService>('/services', 'services')
  if (!res.ok) {
    throw new Error(`Failed to list services: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** List all escalation policies (name → id resolution for the service reference). */
export async function listEscalationPolicies(
  client: PagerDutyClient,
): Promise<Array<{ id?: string; name?: string }>> {
  const res = await client.getAll<{ id?: string; name?: string }>('/escalation_policies', 'escalation_policies')
  if (!res.ok) {
    throw new Error(
      `Failed to list escalation policies: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}
