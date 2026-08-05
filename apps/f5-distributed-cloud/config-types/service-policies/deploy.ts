import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage, type F5xcObjectMetadata } from '../../lib/f5xc'
import { extractServicePolicySpecs, parseRuleList, type LiveServicePolicySpec, type ServicePolicySpec } from './validate'

// Irregular plural - confirmed from F5's generated grpc-gateway route
// literal (see canvas.yaml / validate.ts header comments).
const OBJECT_PLURAL = 'service_policys'

export interface ServicePolicyRollbackEntry {
  name: string
  existed: boolean
  prior?: { metadata: F5xcObjectMetadata; spec: LiveServicePolicySpec }
}

/**
 * Deploy service policies to an F5 XC namespace. Objects are identified by
 * NAME (no separate numeric id):
 *   GET  /service_policys/{name}   - 404 means absent
 *   PUT  /service_policys/{name}   - update an existing policy (capture prior)
 *   POST /service_policys          - create a missing policy
 * A matched (existing) policy is only ever UPDATED in place; deploy never deletes.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, tenantHost, namespace } = built

  const specs = extractServicePolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ServicePolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await client.get<LiveServicePolicySpec>(OBJECT_PLURAL, spec.name)
      const specBody = buildServicePolicySpecBody(spec)
      if (!specBody) {
        throw new Error(`Service policy "${spec.name}" has an invalid custom rule list - skipped`)
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
          throw new Error(`Failed to update service policy "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.create(OBJECT_PLURAL, body)
        if (!res.ok) {
          throw new Error(`Failed to create service policy "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} service policy(ies) to ${tenantHost} namespace "${namespace}": ${deployed.join(', ')}`,
      artifacts: { tenantHost, namespace, deployedServicePolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Service policy deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { tenantHost, namespace, deployedServicePolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Build the create/replace spec body for one service policy. Returns null when rule_list JSON is invalid. */
export function buildServicePolicySpecBody(spec: ServicePolicySpec): LiveServicePolicySpec | null {
  const body: LiveServicePolicySpec = { algo: spec.algo }

  if (spec.serverScope === 'server_name') {
    body.server_name = spec.serverName
  } else {
    body.any_server = true
  }

  switch (spec.mode) {
    case 'allow_all_requests':
      body.allow_all_requests = true
      break
    case 'deny_all_requests':
      body.deny_all_requests = true
      break
    case 'rule_list': {
      const rules = parseRuleList(spec.ruleListJson)
      if (!rules) return null
      body.rule_list = { rules }
      break
    }
    default: {
      const listBody: Record<string, unknown> = {}
      if (spec.listPrefixes.length > 0) listBody.prefix_list = { prefixes: spec.listPrefixes }
      if (spec.listCountries.length > 0) listBody.country_list = spec.listCountries
      listBody[spec.listDefaultAction] = true
      body[spec.mode] = listBody
    }
  }

  return body
}

/** Copy a live object's metadata without server-managed fields (safe to PUT back). */
export function stripMetadata(metadata: Partial<F5xcObjectMetadata>): F5xcObjectMetadata {
  const { name, description, disable, labels, annotations } = metadata
  return { name: name as string, description, disable, labels, annotations }
}
