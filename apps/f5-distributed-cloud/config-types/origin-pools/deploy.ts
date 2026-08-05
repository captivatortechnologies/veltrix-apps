import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage, toRef, type F5xcObjectMetadata } from '../../lib/f5xc'
import { extractOriginPoolSpecs, parseOriginServers, type LiveOriginPoolSpec, type OriginPoolSpec } from './validate'

const OBJECT_PLURAL = 'origin_pools'

export interface OriginPoolRollbackEntry {
  name: string
  existed: boolean
  prior?: { metadata: F5xcObjectMetadata; spec: LiveOriginPoolSpec }
}

/**
 * Deploy origin pools to an F5 XC namespace. Objects are identified by NAME
 * (no separate numeric id):
 *   GET  /origin_pools/{name}   - 404 means absent
 *   PUT  /origin_pools/{name}   - update an existing pool (capture prior)
 *   POST /origin_pools          - create a missing pool
 * A matched (existing) pool is only ever UPDATED in place; deploy never deletes.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, tenantHost, namespace } = built

  const specs = extractOriginPoolSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: OriginPoolRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await client.get<LiveOriginPoolSpec>(OBJECT_PLURAL, spec.name)
      const specBody = buildOriginPoolSpecBody(spec)
      if (!specBody) {
        throw new Error(`Origin pool "${spec.name}" has an invalid Origin Servers JSON array - skipped`)
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
          throw new Error(`Failed to update origin pool "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.create(OBJECT_PLURAL, body)
        if (!res.ok) {
          throw new Error(`Failed to create origin pool "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} origin pool(s) to ${tenantHost} namespace "${namespace}": ${deployed.join(', ')}`,
      artifacts: { tenantHost, namespace, deployedOriginPools: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Origin pool deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { tenantHost, namespace, deployedOriginPools: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Build the create/replace spec body for one origin pool. Returns null when originServersJson is invalid. */
export function buildOriginPoolSpecBody(spec: OriginPoolSpec): LiveOriginPoolSpec | null {
  const originServers = parseOriginServers(spec.originServersJson)
  if (!originServers) return null

  const body: LiveOriginPoolSpec = {
    endpoint_selection: spec.endpointSelection,
    loadbalancer_algorithm: spec.loadbalancerAlgorithm,
    origin_servers: originServers,
  }

  if (spec.healthChecks.length > 0) {
    body.healthcheck = spec.healthChecks.map((name) => toRef(name))
  }

  if (spec.portMode === 'port') {
    body.port = spec.port
  } else if (spec.portMode === 'lb_port') {
    body.lb_port = true
  } else {
    body.automatic_port = true
  }

  if (spec.tlsMode === 'use_tls') {
    body.use_tls = {
      tls_config: { default_security: true },
      ...(spec.tlsServerVerification === 'skip_server_verification'
        ? { skip_server_verification: true }
        : { volterra_trusted_ca: true }),
      disable_sni: true,
      default_session_key_caching: true,
    }
  } else {
    body.no_tls = true
  }

  return body
}

/** Copy a live object's metadata without server-managed fields (safe to PUT back). */
export function stripMetadata(metadata: Partial<F5xcObjectMetadata>): F5xcObjectMetadata {
  const { name, description, disable, labels, annotations } = metadata
  return { name: name as string, description, disable, labels, annotations }
}
