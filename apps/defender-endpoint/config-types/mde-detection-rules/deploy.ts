// =============================================================================
// Deploy custom detection rules via the Microsoft Graph BETA API.
//
// Reconciliation is upsert-by-id and non-destructive: for each declared rule we
// PATCH it if a live rule with the same (case-insensitive) id already exists,
// otherwise POST it with the client-provided id. It never deletes rules it did
// not declare — other tools may own rules in the same tenant.
//
// Progress is recorded as we go so a partial failure can be rolled back: each
// entry captures whether the rule already existed (so rollback restores it) or
// was created by this deploy (so rollback deletes it).
// =============================================================================

import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage, parseJson, type MdeClient } from '../../lib/mde'
import { buildRuleBody, extractDetectionRuleSpecs, ruleKey, type LiveRule } from './validate'

/** What rollback needs to undo one deployed rule. */
export interface DetectionRuleRollbackEntry {
  key: string
  label: string
  /** True when a rule with this id already existed and was UPDATED (restore on rollback). */
  existed: boolean
  /** The rule id (created or updated) — used to PATCH/DELETE on rollback. */
  id?: string
  /** The pre-deploy state of an updated rule, so rollback can restore it. */
  prior?: LiveRule
}

/**
 * List every detection rule the credential can see. Rules are few, so a single
 * GET is sufficient — no pagination. Throws on a non-OK response.
 */
export async function listRules(client: MdeClient): Promise<LiveRule[]> {
  const res = await client.graph('GET', '/security/rules/detectionRules')
  if (!res.ok) {
    throw new Error(`Failed to list detection rules: ${mdeErrorMessage(res)}`)
  }
  return parseJson<{ value?: LiveRule[] }>(res.body)?.value ?? []
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiHost } = built

  if (!client.graphAvailable) {
    return { success: false, message: 'Custom detection rules require Microsoft Graph, which is only available in the commercial cloud.' }
  }

  const specs = extractDetectionRuleSpecs(ctx.canvas).filter((s) => s.ruleId)
  const rollbackState: DetectionRuleRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listRules(client)
    const byKey = new Map(existing.filter((r) => r.id).map((r) => [ruleKey(r.id as string), r]))

    for (const spec of specs) {
      const label = spec.ruleId
      const key = ruleKey(spec.ruleId)
      const prior = byKey.get(key)
      const body = buildRuleBody(spec)

      if (prior && prior.id != null) {
        const res = await client.graph('PATCH', `/security/rules/detectionRules/${prior.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update detection rule "${label}": ${mdeErrorMessage(res)}`)
        rollbackState.push({ key, label, existed: true, id: prior.id, prior })
        updated.push(label)
      } else {
        const res = await client.graph('POST', '/security/rules/detectionRules', { body: { id: spec.ruleId, ...body } })
        if (!res.ok) throw new Error(`Failed to create detection rule "${label}": ${mdeErrorMessage(res)}`)
        const createdRule = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ key, label, existed: false, id: createdRule?.id ?? spec.ruleId })
        created.push(label)
      }
    }

    return {
      success: true,
      message: `Deployed ${specs.length} detection rule(s) to ${apiHost} (${created.length} created, ${updated.length} updated)`,
      artifacts: { apiHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Detection rule deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
