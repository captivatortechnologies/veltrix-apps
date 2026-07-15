import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  type CloudflareClient,
} from '../../lib/cloudflare'
import { ACTION, extractRedirectRuleSpecs, parseJsonObject, PHASE, type RedirectRuleSpec, type LiveRule } from './validate'

/**
 * Deploy dynamic redirect rules via the Cloudflare Rulesets engine (zone-scoped).
 *
 * This config type OWNS the zone's `http_request_dynamic_redirect` phase
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

  const specs = extractRedirectRuleSpecs(ctx.canvas).filter((s) => s.name && s.expression && s.redirectJson.trim())

  try {
    const entry = await getEntrypoint(client)
    const desired = specs.map(buildRule)

    const res = await client.zone('PUT', `/rulesets/phases/${PHASE}/entrypoint`, { body: { rules: desired } })
    if (!res.ok) {
      throw new Error(`Failed to deploy redirect rules: ${cloudflareErrorMessage(res)}`)
    }

    return {
      success: true,
      message: `Deployed ${desired.length} redirect rule(s) to zone "${domain}": ${specs.map((s) => s.name).join(', ')}`,
      artifacts: { domain, deployedRules: specs.map((s) => s.name) },
      // The whole prior entrypoint list is the rollback target (declarative replace).
      rollbackData: { priorRules: entry.rules, existed: entry.existed },
    }
  } catch (error) {
    return {
      success: false,
      message: `Redirect rule deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
export function buildRule(spec: RedirectRuleSpec): Record<string, unknown> {
  return {
    ref: spec.ref,
    description: spec.name,
    action: ACTION,
    expression: spec.expression,
    enabled: spec.enabled,
    action_parameters: { from_value: parseJsonObject(spec.redirectJson).value },
  }
}
