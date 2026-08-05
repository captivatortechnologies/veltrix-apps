import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage, toRef, type F5xcObjectMetadata } from '../../lib/f5xc'
import { extractTcpLoadBalancerSpecs, type LiveTcpLoadBalancerSpec, type TcpLoadBalancerSpec } from './validate'

const OBJECT_PLURAL = 'tcp_loadbalancers'

export interface TcpLoadBalancerRollbackEntry {
  name: string
  existed: boolean
  prior?: { metadata: F5xcObjectMetadata; spec: LiveTcpLoadBalancerSpec }
}

/**
 * Deploy TCP load balancers to an F5 XC namespace. Objects are identified by
 * NAME (no separate numeric id):
 *   GET  /tcp_loadbalancers/{name}   - 404 means absent
 *   PUT  /tcp_loadbalancers/{name}   - update an existing load balancer (capture prior)
 *   POST /tcp_loadbalancers          - create a missing load balancer
 * A matched (existing) load balancer is only ever UPDATED in place; deploy
 * never deletes.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, tenantHost, namespace } = built

  const specs = extractTcpLoadBalancerSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: TcpLoadBalancerRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await client.get<LiveTcpLoadBalancerSpec>(OBJECT_PLURAL, spec.name)
      const body = {
        metadata: { name: spec.name, description: spec.description, disable: spec.disable },
        spec: buildTcpLoadBalancerSpecBody(spec),
      }

      if (existing) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          prior: { metadata: stripMetadata(existing.metadata ?? { name: spec.name }), spec: existing.spec ?? {} },
        })
        const res = await client.replace(OBJECT_PLURAL, spec.name, body)
        if (!res.ok) {
          throw new Error(`Failed to update TCP Load Balancer "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.create(OBJECT_PLURAL, body)
        if (!res.ok) {
          throw new Error(`Failed to create TCP Load Balancer "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} TCP Load Balancer(s) to ${tenantHost} namespace "${namespace}": ${deployed.join(', ')}`,
      artifacts: { tenantHost, namespace, deployedTcpLoadBalancers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `TCP Load Balancer deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { tenantHost, namespace, deployedTcpLoadBalancers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Build the create/replace spec body for one TCP load balancer. */
export function buildTcpLoadBalancerSpecBody(spec: TcpLoadBalancerSpec): LiveTcpLoadBalancerSpec {
  const body: LiveTcpLoadBalancerSpec = {
    origin_pools_weights: spec.originPools.map((name) => ({ pool: toRef(name) })),
  }

  if (spec.domains.length > 0) body.domains = spec.domains
  if (spec.idleTimeoutMs !== undefined) body.idle_timeout = spec.idleTimeoutMs

  if (spec.listenPortMode === 'listen_port') {
    body.listen_port = spec.listenPort
  } else {
    body.port_ranges = spec.portRanges
  }

  body[spec.advertiseMode] = true
  body[spec.retractCluster ? 'retract_cluster' : 'do_not_retract_cluster'] = true

  if (spec.tlsMode === 'tls_tcp_auto_cert') {
    body.tls_tcp_auto_cert = { no_mtls: true }
  } else {
    body.tcp = true
  }

  body[`hash_policy_choice_${spec.loadBalancingAlgorithm}`] = true

  if (spec.servicePoliciesMode === 'active_service_policies') {
    body.active_service_policies = { policies: spec.activeServicePolicies.map((name) => toRef(name)) }
  } else {
    body[spec.servicePoliciesMode] = true
  }

  if (spec.sniMode === 'sni') {
    body.sni = { sni: spec.sniValue }
  } else {
    body[spec.sniMode] = true
  }

  return body
}

/** Copy a live object's metadata without server-managed fields (safe to PUT back). */
export function stripMetadata(metadata: Partial<F5xcObjectMetadata>): F5xcObjectMetadata {
  const { name, description, disable, labels, annotations } = metadata
  return { name: name as string, description, disable, labels, annotations }
}
