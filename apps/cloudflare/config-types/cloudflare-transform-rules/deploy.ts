import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  type CloudflareClient,
} from '../../lib/cloudflare'
import {
  extractTransformRuleSpecs,
  parseJsonObject,
  RULE_ACTION,
  type LiveRule,
  type TransformRuleSpec,
} from './validate'

/** Prior state captured for one phase entrypoint so rollback can restore it. */
export interface PhaseRollback {
  priorRules: LiveRule[]
  existed: boolean
}

/**
 * Deploy transform rules via the Cloudflare Rulesets engine (zone-scoped).
 *
 * Transform rules span THREE phases (url_rewrite → http_request_transform,
 * request_headers → http_request_late_transform, response_headers →
 * http_response_headers_transform) and a single canvas may mix them. This config
 * type OWNS each of those phase entrypoints declaratively: we group the specs by
 * their phase, then for every phase GET the entrypoint (capturing its rules for
 * rollback) and PUT the desired subset. Rules carry a stable `ref` derived from
 * the name so identity survives across ruleset versions.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractTransformRuleSpecs(ctx.canvas).filter((s) => s.name && s.expression && s.phase)

  // Group specs by the phase entrypoint they land in — one PUT per phase.
  const byPhase = new Map<string, TransformRuleSpec[]>()
  for (const spec of specs) {
    const phase = spec.phase as string
    const list = byPhase.get(phase)
    if (list) list.push(spec)
    else byPhase.set(phase, [spec])
  }

  const phases: Record<string, PhaseRollback> = {}

  try {
    for (const [phase, phaseSpecs] of byPhase) {
      // Capture the prior entrypoint for this phase BEFORE overwriting it.
      const entry = await getEntrypoint(client, phase)
      phases[phase] = { priorRules: entry.rules, existed: entry.existed }

      const desired = phaseSpecs.map(buildRule)
      const res = await client.zone('PUT', `/rulesets/phases/${phase}/entrypoint`, { body: { rules: desired } })
      if (!res.ok) {
        throw new Error(`Failed to deploy transform rules to phase "${phase}": ${cloudflareErrorMessage(res)}`)
      }
    }

    return {
      success: true,
      message: `Deployed ${specs.length} transform rule(s) across ${byPhase.size} phase(s) to zone "${domain}": ${specs
        .map((s) => s.name)
        .join(', ')}`,
      artifacts: { domain, deployedRules: specs.map((s) => s.name), phases: [...byPhase.keys()] },
      // Each phase's prior entrypoint list is its rollback target (declarative replace).
      rollbackData: { phases },
    }
  } catch (error) {
    return {
      success: false,
      message: `Transform rule deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

/** Fetch a phase entrypoint ruleset; a 404 means no entrypoint yet (empty list). */
export async function getEntrypoint(client: CloudflareClient, phase: string): Promise<Entrypoint> {
  const res = await client.zone('GET', `/rulesets/phases/${phase}/entrypoint`)
  if (res.status === 404) return { id: null, rules: [], existed: false }
  if (!res.ok) {
    throw new Error(`Failed to read the ${phase} entrypoint: ${cloudflareErrorMessage(res)}`)
  }
  const result = cloudflareResult<{ id?: string; rules?: LiveRule[] }>(res)
  return { id: result?.id ?? null, rules: result?.rules ?? [], existed: true }
}

/** Build a Cloudflare ruleset rule object from a canvas spec (always `rewrite`). */
export function buildRule(spec: TransformRuleSpec): Record<string, unknown> {
  return {
    ref: spec.ref,
    description: spec.name,
    action: RULE_ACTION,
    expression: spec.expression,
    enabled: spec.enabled,
    action_parameters: parseJsonObject(spec.transformJson).value ?? {},
  }
}
