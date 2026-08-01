import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import {
  buildPolicyBody,
  extractPolicySpecs,
  parseEscalationRules,
  type LiveEscalationPolicy,
} from './_shared'

/** Per-policy rollback record captured during deploy. */
export interface EscalationPolicyRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: LiveEscalationPolicy
}

/**
 * Deploy PagerDuty escalation policies over the REST API v2:
 *   read (rollback): GET  /escalation_policies         → find each live policy by name
 *   create:          POST /escalation_policies          with { escalation_policy: {...} }
 *   update:          PUT  /escalation_policies/{id}      with { escalation_policy: {...} }
 *
 * The name is the stable identity used to upsert. rollbackData records, per policy,
 * whether it existed and its prior body — so rollback can restore an updated policy
 * or delete a newly created one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name && s.rulesJson.trim())
  const rollbackState: EscalationPolicyRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listPolicies(client)
    const byName = new Map(existing.filter((p) => p.name).map((p) => [String(p.name).toLowerCase(), p]))

    for (const spec of specs) {
      const parsed = parseEscalationRules(spec.rulesJson)
      if (parsed.error || !parsed.rules) {
        throw new Error(`Escalation policy "${spec.name}" has invalid rules: ${parsed.error ?? 'unknown'}`)
      }
      const body = { escalation_policy: buildPolicyBody(spec, parsed.rules) }
      const live = byName.get(spec.name.toLowerCase())

      if (live && live.id) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/escalation_policies/${encodeURIComponent(live.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to update escalation policy "${spec.name}": ${pagerDutyErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/escalation_policies', { body })
        if (!res.ok) throw new Error(`Failed to create escalation policy "${spec.name}": ${pagerDutyErrorMessage(res)}`)
        const created = parseJson<{ escalation_policy?: LiveEscalationPolicy }>(res.body)?.escalation_policy
        if (!created?.id) throw new Error(`Escalation policy "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} escalation policy(ies): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Escalation policy deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all escalation policies in the account; throws on a non-OK response. */
export async function listPolicies(client: PagerDutyClient): Promise<LiveEscalationPolicy[]> {
  const res = await client.getAll<LiveEscalationPolicy>('/escalation_policies', 'escalation_policies')
  if (!res.ok) {
    throw new Error(`Failed to list escalation policies: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
