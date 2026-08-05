import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage, type F5xcObjectMetadata } from '../../lib/f5xc'
import { extractHealthCheckSpecs, type HealthCheckSpec, type LiveHealthCheckSpec } from './validate'

const OBJECT_PLURAL = 'healthchecks'

export interface HealthCheckRollbackEntry {
  name: string
  existed: boolean
  /** Prior { metadata, spec } (system-managed fields stripped), replayed via PUT on rollback. */
  prior?: { metadata: F5xcObjectMetadata; spec: LiveHealthCheckSpec }
}

/**
 * Deploy health checks to an F5 XC namespace. F5 XC objects are identified by
 * NAME (not a separate numeric id), so each declared health check is a direct
 * GET by name (no list-and-scan needed):
 *   GET  /healthchecks/{name}   - 404 means absent
 *   PUT  /healthchecks/{name}   - update an existing health check (capture prior)
 *   POST /healthchecks          - create a missing health check
 * A matched (existing) health check is only ever UPDATED in place; deploy
 * never deletes.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, tenantHost, namespace } = built

  const specs = extractHealthCheckSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: HealthCheckRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await client.get<LiveHealthCheckSpec>(OBJECT_PLURAL, spec.name)
      const body = { metadata: { name: spec.name, description: spec.description, disable: spec.disable }, spec: buildHealthCheckSpecBody(spec) }

      if (existing) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          prior: { metadata: stripMetadata(existing.metadata ?? { name: spec.name }), spec: existing.spec ?? {} },
        })
        const res = await client.replace(OBJECT_PLURAL, spec.name, body)
        if (!res.ok) {
          throw new Error(`Failed to update health check "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.create(OBJECT_PLURAL, body)
        if (!res.ok) {
          throw new Error(`Failed to create health check "${spec.name}": ${f5xcErrorMessage(res)}`)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} health check(s) to ${tenantHost} namespace "${namespace}": ${deployed.join(', ')}`,
      artifacts: { tenantHost, namespace, deployedHealthChecks: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Health check deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { tenantHost, namespace, deployedHealthChecks: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Build the create/replace spec body for one health check. */
export function buildHealthCheckSpecBody(spec: HealthCheckSpec): LiveHealthCheckSpec {
  const body: LiveHealthCheckSpec = {
    interval: spec.interval,
    timeout: spec.timeout,
    healthy_threshold: spec.healthyThreshold,
    unhealthy_threshold: spec.unhealthyThreshold,
  }
  if (spec.jitterPercent !== undefined) body.jitter_percent = spec.jitterPercent

  if (spec.checkType === 'tcp') {
    body.tcp_health_check = {
      ...(spec.tcpSendPayload ? { send_payload: spec.tcpSendPayload } : {}),
      ...(spec.tcpExpectedResponse ? { expected_response: spec.tcpExpectedResponse } : {}),
    }
  } else if (spec.checkType === 'udp_icmp') {
    body.udp_icmp_health_check = true
  } else {
    body.http_health_check = {
      path: spec.httpPath || '/',
      ...(spec.httpExpectedStatusCodes ? { expected_status_codes: spec.httpExpectedStatusCodes } : {}),
      ...(spec.httpExpectedResponse ? { expected_response: spec.httpExpectedResponse } : {}),
      use_http2: spec.httpUseHttp2,
      ...(spec.httpUseOriginServerName
        ? { use_origin_server_name: true }
        : { host_header: spec.httpHostHeader || '' }),
    }
  }
  return body
}

/** Copy a live object's metadata without server-managed fields (safe to PUT back). */
export function stripMetadata(metadata: Partial<F5xcObjectMetadata>): F5xcObjectMetadata {
  const { name, description, disable, labels, annotations } = metadata
  return { name: name as string, description, disable, labels, annotations }
}
