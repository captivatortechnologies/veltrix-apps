import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage, boolFlag, compactBody, parseJson, type AkeylessClient } from '../../lib/akeyless'
import { extractDynamicSecretSpecs, type DynamicSecretSpec, type DynamicSecretType } from './validate'

export interface LiveDynamicSecret {
  dynamic_secret_type?: string
  [key: string]: unknown
}

export interface DynamicSecretRollbackEntry {
  name: string
  existed: boolean
  priorSpec?: DynamicSecretSpec
}

/**
 * Deploy Akeyless dynamic secret producer configs. ONE item = ONE producer,
 * matched on NAME:
 *   - GET  /dynamic-secret-get             (404 -> does not exist yet)
 *   - POST /dynamic-secret-create-{type}   (type fixed for a new item)
 *   - POST /dynamic-secret-update-{type}   (type must match the LIVE type)
 * Never deletes a producer absent from this canvas - rollback only reverts
 * what THIS deploy created or changed. Never touches produced credential
 * VALUES (out of scope; see canvas.yaml).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractDynamicSecretSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: DynamicSecretRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getDynamicSecret(client, spec.name)

      if (existing) {
        const liveType = detectLiveType(existing)
        if (liveType !== 'unknown' && liveType !== spec.type) {
          throw new Error(
            `Dynamic secret config "${spec.name}" already exists as type "${liveType}" - this app does not ` +
              `support changing a producer's type in place (declared type is "${spec.type}").`,
          )
        }
        rollbackState.push({ name: spec.name, existed: true, priorSpec: mapLiveToSpec(spec, existing) })

        const res = await client.request(`/dynamic-secret-update-${spec.type}`, buildBody(spec, { isUpdate: true }))
        if (!res.ok) throw new Error(`Failed to update dynamic secret config "${spec.name}": ${akeylessErrorMessage(res)}`)
      } else {
        rollbackState.push({ name: spec.name, existed: false })

        const res = await client.request(`/dynamic-secret-create-${spec.type}`, buildBody(spec, { isUpdate: false }))
        if (!res.ok) throw new Error(`Failed to create dynamic secret config "${spec.name}": ${akeylessErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} dynamic secret config(s) to Akeyless (${baseUrl}): ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedConfigs: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Dynamic secret config deployment failed after ${deployed.length} of ${specs.length} item(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedConfigs: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers -------------------------------------------------------------------

export async function getDynamicSecret(client: AkeylessClient, name: string): Promise<LiveDynamicSecret | null> {
  const res = await client.request('/dynamic-secret-get', { name })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to look up dynamic secret config "${name}": ${akeylessErrorMessage(res)}`)
  return parseJson<LiveDynamicSecret>(res.body) ?? {}
}

/**
 * Akeyless does not return an explicit "producer type" enum for
 * dynamic-secret-get in the OpenAPI spec - it is inferred from which
 * type-specific fields are populated (the same convention this app uses
 * for auth methods and targets).
 */
export function detectLiveType(live: LiveDynamicSecret): DynamicSecretType | 'unknown' {
  if ('postgres_creation_statements' in live || 'db_user_name' in live) return 'postgresql'
  if ('aws_access_key_id' in live) return 'aws'
  if ('k8s_cluster_endpoint' in live) return 'k8s'
  return 'unknown'
}

export function buildBody(spec: DynamicSecretSpec, opts: { isUpdate: boolean }): Record<string, unknown> {
  const common: Record<string, unknown> = {
    name: spec.name,
    'target-name': spec.targetName,
    description: spec.description,
    delete_protection: boolFlag(spec.deleteProtection),
    'user-ttl': spec.userTtl,
    tags: spec.tags,
    'item-custom-fields': spec.itemCustomFields,
  }
  if (opts.isUpdate) common['new-name'] = spec.name

  let specific: Record<string, unknown> = {}
  switch (spec.type) {
    case 'postgresql':
      specific = {
        'postgresql-host': spec.postgresqlHost,
        'postgresql-port': spec.postgresqlPort,
        'postgresql-db-name': spec.postgresqlDbName,
        'postgresql-username': spec.postgresqlUsername,
        ssl: spec.ssl,
        'password-length': spec.passwordLengthPostgresql,
        'creation-statements': spec.creationStatements,
        'revocation-statements': spec.revocationStatements,
      }
      if (spec.postgresqlPassword) specific['postgresql-password'] = spec.postgresqlPassword
      break
    case 'aws':
      specific = {
        'access-mode': spec.accessMode,
        'aws-access-key-id': spec.awsAccessKeyId,
        region: spec.region,
        // These 3 fields are comma-joined strings on the wire, not arrays
        // (confirmed from the terraform provider's own TypeString schema).
        'aws-user-policies': spec.awsUserPolicies.join(','),
        'aws-user-groups': spec.awsUserGroups.join(','),
        'aws-role-arns': spec.awsRoleArns.join(','),
        'aws-external-id': spec.awsExternalId,
        'enable-admin-rotation': spec.enableAdminRotation,
        'admin-rotation-interval-days': spec.adminRotationIntervalDays,
        'password-length': spec.passwordLengthAws,
      }
      if (spec.awsAccessSecretKey) specific['aws-access-secret-key'] = spec.awsAccessSecretKey
      break
    case 'k8s':
      specific = {
        'k8s-cluster-endpoint': spec.k8sClusterEndpoint,
        'k8s-cluster-name': spec.k8sClusterName,
        'k8s-namespace': spec.k8sNamespace,
        'k8s-service-account': spec.k8sServiceAccount,
        'use-gw-service-account': spec.useGwServiceAccount,
      }
      if (spec.k8sClusterCaCert) specific['k8s-cluster-ca-cert'] = spec.k8sClusterCaCert
      if (spec.k8sClusterToken) specific['k8s-cluster-token'] = spec.k8sClusterToken
      break
    default:
      specific = {}
  }

  return compactBody({ ...common, ...specific })
}

/**
 * Reconstruct a DynamicSecretSpec-shaped rollback snapshot from a live
 * /dynamic-secret-get response, for the NON-SENSITIVE fields Akeyless
 * returns. Write-only admin credentials (postgresqlPassword,
 * awsAccessSecretKey, k8sClusterCaCert/Token) are NOT recoverable.
 */
export function mapLiveToSpec(declared: DynamicSecretSpec, live: LiveDynamicSecret): DynamicSecretSpec {
  const l = live as Record<string, any>
  const base: DynamicSecretSpec = { ...declared, userTtl: (l.user_ttl as string) ?? declared.userTtl }

  const type = detectLiveType(live)
  if (type === 'postgresql') {
    return {
      ...base,
      postgresqlHost: l.host_name ?? base.postgresqlHost,
      postgresqlPort: l.host_port ?? base.postgresqlPort,
      postgresqlDbName: l.db_name ?? '',
      postgresqlUsername: l.user_name ?? l.db_user_name ?? '',
      ssl: Boolean(l.ssl_connection_mode),
      creationStatements: l.postgres_creation_statements ?? '',
      revocationStatements: l.postgres_revocation_statements ?? '',
    }
  }
  if (type === 'aws') {
    return {
      ...base,
      accessMode: l.aws_access_mode ?? base.accessMode,
      awsAccessKeyId: l.aws_access_key_id ?? '',
      region: l.aws_region ?? base.region,
      awsUserPolicies: splitCsv(l.aws_user_policies),
      awsUserGroups: splitCsv(l.aws_user_groups),
      awsRoleArns: splitCsv(l.aws_role_arns),
      awsExternalId: l.aws_external_id ?? '',
      enableAdminRotation: Boolean(l.enable_admin_rotation),
      adminRotationIntervalDays: l.admin_rotation_interval_days != null ? String(l.admin_rotation_interval_days) : '',
    }
  }
  if (type === 'k8s') {
    return {
      ...base,
      k8sClusterEndpoint: l.k8s_cluster_endpoint ?? '',
      k8sClusterName: l.k8s_cluster_name ?? '',
      k8sNamespace: l.k8s_namespace ?? base.k8sNamespace,
      k8sServiceAccount: l.k8s_service_account ?? '',
      useGwServiceAccount: Boolean(l.use_gw_service_account),
    }
  }
  return base
}

function splitCsv(value: unknown): string[] {
  return typeof value === 'string' && value ? value.split(',').filter(Boolean) : []
}
