import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  type CloudflareClient,
} from '../../lib/cloudflare'
import { extractManagedRulesetSpecs, parseJsonObject, PHASE, ACTION, type ManagedRulesetSpec, type LiveRule } from './validate'

/**
 * Deploy Cloudflare-managed rulesets via the Rulesets engine (zone-scoped).
 *
 * This config type OWNS the zone's `http_request_firewall_managed` phase
 * entrypoint: the canvas is the full desired ordered list of `execute` rules,
 * each of which deploys (and optionally overrides) one Cloudflare-managed
 * ruleset. We GET the current entrypoint (capturing its rules for rollback),
 * then PUT the desired list — declarative and order-preserving. Rules carry a
 * stable `ref` derived from the name so identity survives across ruleset
 * versions.
 *
 * NOTE: a Cloudflare-managed ruleset is READ-ONLY. We never edit the managed
 * rules; we only deploy the ruleset into the phase and optionally apply
 * overrides on top of it via action_parameters.overrides.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractManagedRulesetSpecs(ctx.canvas).filter((s) => s.name && s.managedRulesetId)

  try {
    const entry = await getEntrypoint(client)
    const desired = specs.map(buildRule)

    const res = await client.zone('PUT', `/rulesets/phases/${PHASE}/entrypoint`, { body: { rules: desired } })
    if (!res.ok) {
      throw new Error(`Failed to deploy managed rulesets: ${cloudflareErrorMessage(res)}`)
    }

    return {
      success: true,
      message: `Deployed ${desired.length} managed ruleset(s) to zone "${domain}": ${specs.map((s) => s.name).join(', ')}`,
      artifacts: { domain, deployedRules: specs.map((s) => s.name) },
      // The whole prior entrypoint list is the rollback target (declarative replace).
      rollbackData: { priorRules: entry.rules, existed: entry.existed },
    }
  } catch (error) {
    return {
      success: false,
      message: `Managed ruleset deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

/**
 * Build a Cloudflare ruleset `execute` rule that deploys one managed ruleset.
 * action_parameters always carries the managed ruleset `id`, and carries
 * `overrides` only when overrides_json parses to a non-empty object.
 */
export function buildRule(spec: ManagedRulesetSpec): Record<string, unknown> {
  const actionParameters: Record<string, unknown> = { id: spec.managedRulesetId }
  const overrides = parseJsonObject(spec.overridesJson)
  if (overrides.value && Object.keys(overrides.value).length > 0) {
    actionParameters.overrides = overrides.value
  }
  return {
    ref: spec.ref,
    description: spec.name,
    action: ACTION,
    expression: spec.expression || 'true',
    enabled: spec.enabled,
    action_parameters: actionParameters,
  }
}
