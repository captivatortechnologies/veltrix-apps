import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage, toRef, type F5xcObjectMetadata } from '../../lib/f5xc'
import {
  extractHttpLoadBalancerSpecs,
  parseRoutesJson,
  type HttpLoadBalancerSpec,
  type LiveHttpLoadBalancerSpec,
} from './validate'

const OBJECT_PLURAL = 'http_loadbalancers'

export interface HttpLoadBalancerRollbackEntry {
  name: string
  existed: boolean
  prior?: { metadata: F5xcObjectMetadata; spec: LiveHttpLoadBalancerSpec }
}

/**
 * Deploy HTTP load balancers to an F5 XC namespace. Objects are identified by
 * NAME (no separate numeric id):
 *   GET  /http_loadbalancers/{name}   - 404 means absent
 *   PUT  /http_loadbalancers/{name}   - update an existing load balancer (capture prior)
 *   POST /http_loadbalancers          - create a missing load balancer
 * A matched (existing) load balancer is only ever UPDATED in place; deploy
 * never deletes.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, tenantHost, namespace } = built

  const specs = extractHttpLoadBalancerSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: HttpLoadBalancerRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await client.get<LiveHttpLoadBalancerSpec>(OBJECT_PLURAL, spec.name)
      const specBody = buildHttpLoadBalancerSpecBody(spec)
      if (!specBody) {
        throw new Error(`HTTP Load Balancer "${spec.name}" has an invalid Routes JSON array - skipped`)
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
          throw new Error(`Failed to update HTTP Load Balancer "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.create(OBJECT_PLURAL, body)
        if (!res.ok) {
          throw new Error(`Failed to create HTTP Load Balancer "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} HTTP Load Balancer(s) to ${tenantHost} namespace "${namespace}": ${deployed.join(', ')}`,
      artifacts: { tenantHost, namespace, deployedHttpLoadBalancers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `HTTP Load Balancer deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { tenantHost, namespace, deployedHttpLoadBalancers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Build the create/replace spec body for one HTTP load balancer. Returns null when Routes JSON is invalid. */
export function buildHttpLoadBalancerSpecBody(spec: HttpLoadBalancerSpec): LiveHttpLoadBalancerSpec | null {
  const routes = parseRoutesJson(spec.routesJson)
  if (routes === null) return null

  const body: LiveHttpLoadBalancerSpec = {
    domains: spec.domains,
    default_route_pools: spec.defaultRoutePools.map((name) => ({ pool: toRef(name) })),
  }

  if (routes.length > 0) {
    body.routes = routes.map((simple_route) => ({ simple_route }))
  }

  if (spec.tlsMode === 'http') {
    body.http = { port: spec.httpPort ?? 80 }
  } else {
    body.https_auto_cert = { http_redirect: spec.httpRedirect, port: spec.httpsPort ?? 443 }
  }

  body[spec.loadBalancingAlgorithm] = true

  if (spec.wafMode === 'app_firewall') {
    body.app_firewall = toRef(spec.appFirewallName as string)
  } else {
    body.disable_waf = true
  }

  body[spec.maliciousUserDetectionMode] = true
  if (spec.maliciousUserDetectionMode === 'enable_malicious_user_detection' && spec.maliciousUserMitigationName) {
    body.malicious_user_mitigation = toRef(spec.maliciousUserMitigationName)
  }

  if (spec.rateLimitMode === 'rate_limit') {
    body.rate_limit = {
      no_policies: true,
      no_ip_allowed_list: true,
      rate_limiter: {
        use_http_lb_user_id: true,
        threshold: spec.rateLimitThreshold,
        unit: spec.rateLimitUnit,
      },
    }
  } else {
    body.disable_rate_limit = true
  }

  if (spec.corsEnabled) {
    body.cors_policy = {
      disabled: false,
      ...(spec.corsAllowOrigin.length > 0 ? { allow_origin: spec.corsAllowOrigin } : {}),
      ...(spec.corsAllowMethods.length > 0 ? { allow_methods: spec.corsAllowMethods.join(', ') } : {}),
      ...(spec.corsAllowHeaders.length > 0 ? { allow_headers: spec.corsAllowHeaders.join(', ') } : {}),
      allow_credentials: spec.corsAllowCredentials,
      ...(spec.corsMaxAge !== undefined ? { maximum_age: spec.corsMaxAge } : {}),
    }
  }

  if (spec.servicePoliciesMode === 'active_service_policies') {
    body.active_service_policies = { policies: spec.activeServicePolicies.map((name) => toRef(name)) }
  } else {
    body[spec.servicePoliciesMode] = true
  }

  body[spec.advertiseMode] = true

  return body
}

/** Copy a live object's metadata without server-managed fields (safe to PUT back). */
export function stripMetadata(metadata: Partial<F5xcObjectMetadata>): F5xcObjectMetadata {
  const { name, description, disable, labels, annotations } = metadata
  return { name: name as string, description, disable, labels, annotations }
}
