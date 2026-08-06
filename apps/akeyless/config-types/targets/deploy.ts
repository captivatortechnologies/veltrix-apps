import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage, boolFlag, compactBody, parseJson, type AkeylessClient } from '../../lib/akeyless'
import { extractTargetSpecs, type TargetSpec, type TargetType } from './validate'

export interface LiveTargetDetails {
  db_target_details?: Record<string, unknown>
  aws_target_details?: Record<string, unknown>
  native_k8s_target_details?: Record<string, unknown>
}
export interface LiveTargetGetDetails {
  target?: { target_type?: string; comment?: string; delete_protection?: boolean }
  value?: LiveTargetDetails
}

export interface TargetRollbackEntry {
  name: string
  existed: boolean
  /** Prior spec (minus write-only secrets) captured before this deploy - used to restore on rollback. */
  priorSpec?: TargetSpec
}

/**
 * Deploy Akeyless targets. ONE item = ONE target, matched on NAME:
 *   - GET  /target-get-details        (404 -> does not exist yet)
 *   - POST /target-create-{type}      (type fixed for a new item)
 *   - POST /target-update-{type}      (type must match the LIVE type -
 *     changing type in place is refused, see canvas.yaml header)
 * Never deletes a target absent from this canvas - rollback only reverts
 * what THIS deploy created or changed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractTargetSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: TargetRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getTargetDetails(client, spec.name)

      if (existing) {
        const liveType = detectLiveTargetType(existing)
        if (liveType !== 'unknown' && liveType !== spec.type) {
          throw new Error(
            `Target "${spec.name}" already exists as type "${liveType}" - this app does not support changing ` +
              `a target's type in place (declared type is "${spec.type}"). Rename this canvas item to create a ` +
              'new target instead, or delete the existing one in Akeyless first.',
          )
        }

        rollbackState.push({ name: spec.name, existed: true, priorSpec: mapLiveDetailsToSpec(spec, existing) })

        const res = await client.request(`/target-update-${spec.type}`, buildTargetBody(spec, { isUpdate: true }))
        if (!res.ok) throw new Error(`Failed to update target "${spec.name}": ${akeylessErrorMessage(res)}`)
      } else {
        rollbackState.push({ name: spec.name, existed: false })

        const res = await client.request(`/target-create-${spec.type}`, buildTargetBody(spec, { isUpdate: false }))
        if (!res.ok) throw new Error(`Failed to create target "${spec.name}": ${akeylessErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} target(s) to Akeyless (${baseUrl}): ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedTargets: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Target deployment failed after ${deployed.length} of ${specs.length} item(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedTargets: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers -------------------------------------------------------------------

/** GET /target-get-details by name. Returns null on a genuine 404 ("does not exist"), throws otherwise. */
export async function getTargetDetails(client: AkeylessClient, name: string): Promise<LiveTargetGetDetails | null> {
  const res = await client.request('/target-get-details', { name })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to look up target "${name}": ${akeylessErrorMessage(res)}`)
  return parseJson<LiveTargetGetDetails>(res.body) ?? {}
}

export function detectLiveTargetType(live: LiveTargetGetDetails): TargetType | 'unknown' {
  if (live.value?.db_target_details) return 'db'
  if (live.value?.aws_target_details) return 'aws'
  if (live.value?.native_k8s_target_details) return 'k8s'
  return 'unknown'
}

/** Build the create/update request body for a given target type - kebab-case keys, per the API. */
export function buildTargetBody(spec: TargetSpec, opts: { isUpdate: boolean }): Record<string, unknown> {
  const common: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    delete_protection: boolFlag(spec.deleteProtection),
    'max-versions': spec.maxVersions,
  }
  if (opts.isUpdate) common['new-name'] = spec.name

  let specific: Record<string, unknown> = {}
  switch (spec.type) {
    case 'db':
      specific = {
        'db-type': spec.dbType,
        'connection-type': spec.connectionType,
        host: spec.host,
        port: spec.port,
        'db-name': spec.dbName,
        'user-name': spec.userName,
        ssl: spec.ssl,
        'ssl-certificate': spec.sslCertificate,
        'db-server-certificates': spec.dbServerCertificates,
        'db-server-name': spec.dbServerName,
        'enable-mtls': spec.enableMtls,
      }
      // Write-only: only sent when the author actually typed a new value -
      // leaving it blank on an existing target keeps the current value.
      if (spec.pwd) specific.pwd = spec.pwd
      if (spec.clientCertificate) specific['client-certificate'] = spec.clientCertificate
      if (spec.clientPrivateKey) specific['client-private-key'] = spec.clientPrivateKey
      if (spec.clientKeyPassphrase) specific['client-key-passphrase'] = spec.clientKeyPassphrase
      break
    case 'aws':
      specific = {
        'access-key-id': spec.accessKeyId,
        region: spec.region,
        'use-gw-cloud-identity': spec.useGwCloudIdentity,
        'generate-external-id': spec.generateExternalId,
        'role-arn': spec.roleArn,
      }
      if (spec.accessKey) specific['access-key'] = spec.accessKey
      if (spec.sessionToken) specific['session-token'] = spec.sessionToken
      break
    case 'k8s':
      specific = {
        'k8s-cluster-endpoint': spec.k8sClusterEndpoint,
        'k8s-auth-type': spec.k8sAuthType,
        'k8s-cluster-name': spec.k8sClusterName,
        'use-gw-service-account': spec.useGwServiceAccount,
      }
      if (spec.k8sClusterCaCert) specific['k8s-cluster-ca-cert'] = spec.k8sClusterCaCert
      if (spec.k8sClusterToken) specific['k8s-cluster-token'] = spec.k8sClusterToken
      if (spec.k8sClientCertificate) specific['k8s-client-certificate'] = spec.k8sClientCertificate
      if (spec.k8sClientKey) specific['k8s-client-key'] = spec.k8sClientKey
      break
    default:
      specific = {}
  }

  return compactBody({ ...common, ...specific })
}

/**
 * Reconstruct a TargetSpec-shaped rollback snapshot from a live
 * /target-get-details response, for the NON-SENSITIVE fields Akeyless
 * actually returns. Write-only fields (pwd, accessKey, sessionToken,
 * k8sClusterCaCert/Token, client certs/keys) are NOT recoverable - rollback
 * restores every other field, but secret material rotated by this deploy
 * cannot be reverted.
 */
export function mapLiveDetailsToSpec(declared: TargetSpec, live: LiveTargetGetDetails): TargetSpec {
  const base: TargetSpec = {
    ...declared,
    description: live.target?.comment ?? '',
    deleteProtection: Boolean(live.target?.delete_protection),
  }

  const type = detectLiveTargetType(live)
  if (type === 'db') {
    const d = (live.value?.db_target_details ?? {}) as Record<string, any>
    return {
      ...base,
      connectionType: d.connection_type ?? base.connectionType,
      host: d.db_host_name ?? '',
      port: d.db_port ?? '',
      dbName: d.db_name ?? '',
      userName: d.db_user_name ?? '',
      ssl: Boolean(d.ssl_connection_mode),
      sslCertificate: d.ssl_connection_certificate ?? '',
      dbServerCertificates: d.db_server_certificates ?? '',
      dbServerName: d.db_server_name ?? '',
      enableMtls: Boolean(d.enable_mtls),
    }
  }
  if (type === 'aws') {
    const d = (live.value?.aws_target_details ?? {}) as Record<string, any>
    return {
      ...base,
      accessKeyId: d.aws_access_key_id ?? '',
      region: d.aws_region ?? base.region,
      useGwCloudIdentity: Boolean(d.use_gw_cloud_identity),
    }
  }
  if (type === 'k8s') {
    const d = (live.value?.native_k8s_target_details ?? {}) as Record<string, any>
    return {
      ...base,
      k8sClusterEndpoint: d.k8s_cluster_endpoint ?? '',
      k8sAuthType: d.k8s_auth_type ?? base.k8sAuthType,
      k8sClusterName: d.k8s_cluster_name ?? '',
      useGwServiceAccount: Boolean(d.use_gw_service_account),
    }
  }
  return base
}
