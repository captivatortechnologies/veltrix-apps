import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  MISSING_CUSTOMER_ID_MESSAGE,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractPolicyRuleSpecs,
  isDefaultRule,
  parsePolicyConditions,
  type LivePolicyRule,
  type PolicyRuleSpec,
} from './validate'

export interface PolicyRuleRollbackEntry {
  name: string
  /** The policy set this rule belongs to; lets rollback re-resolve the set id. */
  policyType: string
  /** The resolved policy set id (the CRUD path is keyed by it). */
  policySetId: string
  existed: boolean
  ruleId?: string
  prior?: { name?: string; description?: string; action?: string; conditions?: unknown[] }
}

/**
 * Deploy ZPA policy rules via the Zscaler OneAPI.
 *
 * ZPA models policy as one policy SET per policy type, each holding an ordered
 * list of rules. So every write first resolves the set id for the rule's
 * policy_type (`GET /policySet/policyType/{type}`), then lists that set's rules
 * and matches by name — identity is the (policy_type, name) pair. A matched rule
 * is PUT (update), otherwise POSTed (create). The catch-all DEFAULT rule of a
 * set is protected and never touched. Unlike ZIA, ZPA changes apply IMMEDIATELY
 * — there is no activation step, so a write returning success ends the op.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built
  if (!client.hasCustomerId) {
    return { success: false, message: MISSING_CUSTOMER_ID_MESSAGE }
  }

  const specs = extractPolicyRuleSpecs(ctx.canvas).filter((s) => s.name && s.policyType)
  const rollbackState: PolicyRuleRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  // Resolve each policy set id / rule list at most once per deploy.
  const policySetCache = new Map<string, string>()
  const rulesCache = new Map<string, Map<string, LivePolicyRule>>()

  try {
    for (const spec of specs) {
      const policySetId = await getPolicySetId(client, spec.policyType, policySetCache)
      const byName = await getRulesByName(client, spec.policyType, rulesCache)
      const live = byName.get(spec.name)

      // The catch-all default rule of a policy set cannot be managed as code.
      if (live && isDefaultRule(live)) {
        throw new Error(`"${spec.name}" is the default rule and cannot be modified`)
      }

      const conditions = parsePolicyConditions(spec.conditionsJson)

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          policyType: spec.policyType,
          policySetId,
          existed: true,
          ruleId: live.id,
          prior: {
            name: live.name,
            description: live.description ?? '',
            action: live.action,
            conditions: Array.isArray(live.conditions) ? live.conditions : [],
          },
        })
        const res = await client.zpa('PUT', `/policySet/${policySetId}/rule/${live.id}`, {
          body: buildPayload(spec, policySetId, conditions, live.id),
        })
        if (!res.ok) {
          throw new Error(`Failed to update ${spec.policyType} rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zpa('POST', `/policySet/${policySetId}/rule`, {
          body: buildPayload(spec, policySetId, conditions),
        })
        if (!res.ok) {
          throw new Error(`Failed to create ${spec.policyType} rule "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LivePolicyRule>(res.body)
        if (created?.id == null) {
          throw new Error(`${spec.policyType} rule "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({
          name: spec.name,
          policyType: spec.policyType,
          policySetId,
          existed: false,
          ruleId: String(created.id),
        })
        createdIds.push(String(created.id))
      }

      deployed.push(`${spec.policyType}/${spec.name}`)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ZPA policy rule(s) on tenant "${vanity}": ${deployed.join(', ')}`,
      artifacts: { vanity, deployedPolicyRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy rule deployment failed after ${deployed.length} of ${specs.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedPolicyRules: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/**
 * Resolve the policy set id for a policy type (`GET /policySet/policyType/{type}`
 * → `.id`). Cached per policy type within a deploy so a set is fetched once even
 * when many rules target it. Throws on a non-OK response.
 */
export async function getPolicySetId(
  client: ZscalerClient,
  policyType: string,
  cache?: Map<string, string>,
): Promise<string> {
  const cached = cache?.get(policyType)
  if (cached) return cached

  const res = await client.zpa('GET', `/policySet/policyType/${encodeURIComponent(policyType)}`)
  if (!res.ok) {
    throw new Error(`Failed to resolve the ${policyType} policy set: ${zscalerErrorMessage(res)}`)
  }
  const parsed = parseJson<{ id?: string }>(res.body)
  if (parsed?.id == null) {
    throw new Error(`The ${policyType} policy set response contained no id`)
  }
  const id = String(parsed.id)
  cache?.set(policyType, id)
  return id
}

/** List every rule in a policy set; throws on a non-OK response. */
export async function listPolicyRules(client: ZscalerClient, policyType: string): Promise<LivePolicyRule[]> {
  const res = await client.zpaGetAll<LivePolicyRule>(
    `/policySet/rules/policyType/${encodeURIComponent(policyType)}`,
  )
  if (!res.ok) {
    throw new Error(
      `Failed to list ${policyType} rules: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** List a policy set's rules once per deploy and index them by name. */
async function getRulesByName(
  client: ZscalerClient,
  policyType: string,
  cache: Map<string, Map<string, LivePolicyRule>>,
): Promise<Map<string, LivePolicyRule>> {
  const cached = cache.get(policyType)
  if (cached) return cached
  const live = await listPolicyRules(client, policyType)
  const byName = new Map(live.filter((r) => r.name).map((r) => [r.name as string, r]))
  cache.set(policyType, byName)
  return byName
}

function buildPayload(
  spec: PolicyRuleSpec,
  policySetId: string,
  conditions: unknown[],
  ruleId?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
    policySetId,
    operator: 'AND',
    conditions,
  }
  // action is optional and its valid values depend on the policy type.
  if (spec.action) payload.action = spec.action
  // PUT is replace-style — echo the id back so the record is fully specified.
  if (ruleId != null) payload.id = ruleId
  return payload
}
