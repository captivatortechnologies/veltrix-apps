import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import {
  buildTrafficRuleBody,
  extractTrafficRuleSpecs,
  listTrafficRules,
  trafficRuleKey,
  trafficRulePath,
  type LiveTrafficRule,
} from './validate'

export type TrafficRuleRollbackEntry =
  | { action: 'created'; name: string }
  | { action: 'updated'; name: string; prior: LiveTrafficRule }
  | { action: 'deleted'; name: string; prior: LiveTrafficRule }

export interface TrafficRulesRollbackData {
  entries: TrafficRuleRollbackEntry[]
}

/**
 * Deploy the Application's Traffic Rules via /applications/{appName}/traffic_rules/.
 *
 * This config type OWNS the rule set: the canvas is the complete desired
 * list, reconciled by rule name. Existing rules not declared are removed;
 * declared rules not yet present are created (POST); declared rules that
 * already exist are updated (PUT) unconditionally, so any out-of-band edit is
 * corrected. Every touched rule's prior state is captured for rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, appName } = built

  const specs = extractTrafficRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollback: TrafficRuleRollbackEntry[] = []
  let created = 0
  let updated = 0
  let removed = 0

  try {
    const existing = await listTrafficRules(client, appName)
    const byKey = new Map(existing.filter((r) => r.name).map((r) => [trafficRuleKey(r.name as string), r]))
    const declaredKeys = new Set(specs.map((s) => trafficRuleKey(s.name)))

    for (const spec of specs) {
      const key = trafficRuleKey(spec.name)
      const live = byKey.get(key)
      const body = buildTrafficRuleBody(spec)

      if (live) {
        rollback.push({ action: 'updated', name: spec.name, prior: live })
        const res = await client.request('PUT', trafficRulePath(client, appName, spec.name), { body })
        if (!res.ok) throw new Error(`Failed to update Traffic Rule "${spec.name}": ${barracudaErrorMessage(res)}`)
        updated++
      } else {
        const res = await client.request('POST', `${client.appPath(appName)}/traffic_rules/`, { body })
        if (!res.ok) throw new Error(`Failed to create Traffic Rule "${spec.name}": ${barracudaErrorMessage(res)}`)
        rollback.push({ action: 'created', name: spec.name })
        created++
      }
    }

    for (const rule of existing) {
      if (!rule.name || declaredKeys.has(trafficRuleKey(rule.name))) continue
      rollback.push({ action: 'deleted', name: rule.name, prior: rule })
      const res = await client.request('DELETE', trafficRulePath(client, appName, rule.name))
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to remove undeclared Traffic Rule "${rule.name}": ${barracudaErrorMessage(res)}`)
      }
      removed++
    }

    return {
      success: true,
      message: `Deployed Traffic Rules to Application "${appName}": ${created} created, ${updated} updated, ${removed} removed.`,
      artifacts: { baseUrl, appName, created, updated, removed },
      rollbackData: { entries: rollback } satisfies TrafficRulesRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Traffic Rules deployment failed after ${created + updated} upsert(s), ${removed} removal(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, appName, created, updated, removed },
      rollbackData: { entries: rollback } satisfies TrafficRulesRollbackData,
    }
  }
}
