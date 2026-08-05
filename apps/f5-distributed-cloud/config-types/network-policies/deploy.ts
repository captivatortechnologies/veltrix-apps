import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage, type F5xcObjectMetadata } from '../../lib/f5xc'
import { extractNetworkPolicySpecs, parseRuleListJson, type LiveNetworkPolicySpec, type NetworkPolicySpec } from './validate'

// Irregular plural - confirmed from F5's generated grpc-gateway route
// literal (see canvas.yaml / validate.ts header comments).
const OBJECT_PLURAL = 'network_policys'

export interface NetworkPolicyRollbackEntry {
  name: string
  existed: boolean
  prior?: { metadata: F5xcObjectMetadata; spec: LiveNetworkPolicySpec }
}

/**
 * Deploy network policies to an F5 XC namespace. Objects are identified by
 * NAME (no separate numeric id):
 *   GET  /network_policys/{name}   - 404 means absent
 *   PUT  /network_policys/{name}   - update an existing policy (capture prior)
 *   POST /network_policys          - create a missing policy
 * A matched (existing) policy is only ever UPDATED in place; deploy never deletes.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, tenantHost, namespace } = built

  const specs = extractNetworkPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: NetworkPolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await client.get<LiveNetworkPolicySpec>(OBJECT_PLURAL, spec.name)
      const specBody = buildNetworkPolicySpecBody(spec)
      if (!specBody) {
        throw new Error(`Network policy "${spec.name}" has an invalid ingress/egress rule list - skipped`)
      }
      const body = { metadata: { name: spec.name, description: spec.description, disable: spec.disable }, spec: specBody }

      if (existing) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          prior: { metadata: stripMetadata(existing.metadata ?? { name: spec.name }), spec: existing.spec ?? {} },
        })
        const res = await client.replace(OBJECT_PLURAL, spec.name, body)
        if (!res.ok) {
          throw new Error(`Failed to update network policy "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.create(OBJECT_PLURAL, body)
        if (!res.ok) {
          throw new Error(`Failed to create network policy "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} network policy(ies) to ${tenantHost} namespace "${namespace}": ${deployed.join(', ')}`,
      artifacts: { tenantHost, namespace, deployedNetworkPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network policy deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { tenantHost, namespace, deployedNetworkPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

function buildEndpoint(spec: NetworkPolicySpec): Record<string, unknown> {
  if (spec.endpointMode === 'label_selector') {
    return { label_selector: { expressions: spec.endpointExpressions } }
  }
  return { [spec.endpointMode]: true }
}

/** Build the create/replace spec body for one network policy. Returns null when a rule list JSON is invalid. */
export function buildNetworkPolicySpecBody(spec: NetworkPolicySpec): LiveNetworkPolicySpec | null {
  const ingressRules = parseRuleListJson(spec.ingressRulesJson)
  const egressRules = parseRuleListJson(spec.egressRulesJson)
  if (ingressRules === null || egressRules === null) return null

  const body: LiveNetworkPolicySpec = { endpoint: buildEndpoint(spec) }
  if (ingressRules.length > 0 || egressRules.length > 0) {
    body.rules = {
      ...(ingressRules.length > 0 ? { ingress_rules: ingressRules } : {}),
      ...(egressRules.length > 0 ? { egress_rules: egressRules } : {}),
    }
  }
  return body
}

/** Copy a live object's metadata without server-managed fields (safe to PUT back). */
export function stripMetadata(metadata: Partial<F5xcObjectMetadata>): F5xcObjectMetadata {
  const { name, description, disable, labels, annotations } = metadata
  return { name: name as string, description, disable, labels, annotations }
}
