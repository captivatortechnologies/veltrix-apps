import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  type CloudflareClient,
} from '../../lib/cloudflare'
import { extractCustomRuleSpecs, parseJsonObject, PHASE, type CustomRuleSpec, type LiveRule } from './validate'

/**
 * Deploy WAF custom rules via the Cloudflare Rulesets engine (zone-scoped).
 *
 * This config type OWNS the zone's `http_request_firewall_custom` phase
 * entrypoint: the canvas is the full desired ordered rule list. We GET the
 * current entrypoint (capturing its rules for rollback), then PUT the desired
 * list — declarative and order-preserving. Rules carry a stable `ref` derived
 * from the name so identity survives across ruleset versions.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractCustomRuleSpecs(ctx.canvas).filter((s) => s.name && s.expression)

  try {
    const entry = await getEntrypoint(client)
    const desired = specs.map(buildRule)

    const res = await client.zone('PUT', `/rulesets/phases/${PHASE}/entrypoint`, { body: { rules: desired } })
    if (!res.ok) {
      throw new Error(`Failed to deploy WAF custom rules: ${cloudflareErrorMessage(res)}`)
    }

    return {
      success: true,
      message: `Deployed ${desired.length} WAF custom rule(s) to zone "${domain}": ${specs.map((s) => s.name).join(', ')}`,
      artifacts: { domain, deployedRules: specs.map((s) => s.name) },
      // The whole prior entrypoint list is the rollback target (declarative replace).
      rollbackData: { priorRules: entry.rules, existed: entry.existed },
    }
  } catch (error) {
    return {
      success: false,
      message: `WAF custom rule deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { domain },
    }
  }
}

// --- Helpers (shared with drift / healthCheck) ---

export interface Entrypoint {
  id: string | null
  rules: LiveRule[]
  existed: boolean
}

/** Fetch the phase entrypoint ruleset; a 404 means no entrypoint yet (empty list). */
export async function getEntrypoint(client: CloudflareClient): Promise<Entrypoint> {
  const res = await client.zone('GET', `/rulesets/phases/${PHASE}/entrypoint`)
  if (res.status === 404) return { id: null, rules: [], existed: false }
  if (!res.ok) {
    throw new Error(`Failed to read the ${PHASE} entrypoint: ${cloudflareErrorMessage(res)}`)
  }
  const result = cloudflareResult<{ id?: string; rules?: LiveRule[] }>(res)
  return { id: result?.id ?? null, rules: result?.rules ?? [], existed: true }
}

/** Build a Cloudflare ruleset rule object from a canvas spec. */
export function buildRule(spec: CustomRuleSpec): Record<string, unknown> {
  const rule: Record<string, unknown> = {
    ref: spec.ref,
    description: spec.name,
    action: spec.action,
    expression: spec.expression,
    enabled: spec.enabled,
  }
  const params = parseJsonObject(spec.actionParamsJson)
  if (params.value && Object.keys(params.value).length > 0) rule.action_parameters = params.value
  return rule
}
