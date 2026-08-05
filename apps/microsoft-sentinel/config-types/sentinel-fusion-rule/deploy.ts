import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage, SENTINEL_API_VERSION, type SentinelClient } from '../../lib/sentinel'
import { extractFusionRuleSpecs, FUSION_ALERT_RULE_TEMPLATE_NAME, FUSION_KIND, type FusionRuleSpec } from './validate'

/** A live Microsoft.SecurityInsights/alertRules collection item — only the fields this type reads. */
export interface LiveAlertRule {
  name?: string
  kind?: string
  properties?: Record<string, unknown>
}

/** State captured so a rollback can delete a create or restore an update. */
export interface FusionRollbackEntry {
  ruleId: string
  existed: boolean
  prior?: { kind?: string; properties?: unknown }
}

/**
 * A deterministic fallback ARM ruleId used ONLY when no Fusion rule exists yet.
 * Every onboarded Sentinel workspace has the built-in Fusion rule by default, so
 * this path is rare (e.g. a very old workspace, or one where it was deleted).
 */
export const FUSION_FALLBACK_RULE_ID = 'built-in-fusion'

/**
 * The Microsoft.SecurityInsights FusionAlertRule request body. The ONLY
 * writable properties are `alertRuleTemplateName` (fixed) and `enabled` —
 * severity/tactics/description are inherited from the built-in template and are
 * read-only on GET, never accepted on write.
 */
export function buildFusionRuleBody(spec: FusionRuleSpec): unknown {
  return { kind: FUSION_KIND, properties: { alertRuleTemplateName: FUSION_ALERT_RULE_TEMPLATE_NAME, enabled: spec.enabled } }
}

/** Pure: pick the (at most one) Fusion-kind item out of a live alertRules collection. */
export function pickFusionRule(items: LiveAlertRule[]): LiveAlertRule | null {
  return items.find((r) => r.kind === FUSION_KIND) ?? null
}

/** List the workspace's alert rules and find the (at most one) Fusion-kind item. */
export async function findFusionRule(client: SentinelClient): Promise<LiveAlertRule | null> {
  const res = await client.getAll<LiveAlertRule>(client.sentinelPath('/alertRules'), SENTINEL_API_VERSION)
  if (!res.ok) throw new Error(res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`)
  return pickFusionRule(res.items)
}

/**
 * Deploy the Fusion rule via ARM. Fusion already exists on every onboarded
 * workspace under a SYSTEM-ASSIGNED ruleId, so reconciliation is by KIND, not by
 * a customer-typed name: the workspace's alertRules are listed and matched by
 * kind === "Fusion"; the PUT targets that exact ruleId. Only when no Fusion rule
 * exists yet (rare) is one created, at a deterministic fallback ruleId.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractFusionRuleSpecs(ctx.canvas)
  if (specs.length === 0) {
    return { success: true, message: 'No Fusion rule declared — nothing to deploy', artifacts: { armHost } }
  }
  const spec = specs[0]

  try {
    const existing = await findFusionRule(client)
    const existed = existing != null
    const ruleId = existing?.name || FUSION_FALLBACK_RULE_ID

    const rollbackEntry: FusionRollbackEntry = existed
      ? { ruleId, existed: true, prior: { kind: existing!.kind, properties: existing!.properties } }
      : { ruleId, existed: false }

    const res = await client.request('PUT', client.sentinelPath(`/alertRules/${ruleId}`), {
      apiVersion: SENTINEL_API_VERSION,
      body: buildFusionRuleBody(spec),
    })
    if (!res.ok) throw new Error(`Failed to ${existed ? 'update' : 'create'} the Fusion rule: ${armErrorMessage(res)}`)

    return {
      success: true,
      message: `Fusion rule deployed to ${armHost}: ${existed ? 'updated' : 'created'} (enabled=${spec.enabled})`,
      artifacts: { armHost, ruleId, existed },
      rollbackData: { previousState: [rollbackEntry] },
    }
  } catch (error) {
    return {
      success: false,
      message: `Fusion rule deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost },
    }
  }
}
