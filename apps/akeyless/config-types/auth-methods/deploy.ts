import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage, boolFlag, compactBody, parseJson, type AkeylessClient } from '../../lib/akeyless'
import { extractAuthMethodSpecs, detectLiveAuthMethodType, type AuthMethodSpec, type AuthMethodType } from './validate'

export interface AuthMethodRollbackEntry {
  name: string
  existed: boolean
  /** Prior spec (minus write-only secrets) captured before this deploy - used to restore on rollback. */
  priorSpec?: AuthMethodSpec
}

/**
 * Deploy Akeyless auth methods. ONE item = ONE auth method, matched on NAME:
 *   - GET  /auth-method-get          (404 -> does not exist yet)
 *   - POST /auth-method-create-{type}  (type is fixed for a new item)
 *   - POST /auth-method-update-{type}  (type must match the LIVE type -
 *     changing type in place is refused, see canvas.yaml header)
 * Never deletes an auth method absent from this canvas - rollback only
 * reverts what THIS deploy created or changed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractAuthMethodSpecs(ctx.canvas).filter((s) => s.name && s.type)
  const rollbackState: AuthMethodRollbackEntry[] = []
  const createdNames: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getAuthMethod(client, spec.name)

      if (existing) {
        const liveType = detectLiveAuthMethodType(existing.access_info)
        if (liveType !== 'unknown' && liveType !== spec.type) {
          throw new Error(
            `Auth method "${spec.name}" already exists as type "${liveType}" - this app does not support ` +
              `changing an auth method's type in place (declared type is "${spec.type}"). Delete it in ` +
              'Akeyless first (this rotates its Access ID and breaks dependent Role associations), or rename ' +
              'this canvas item to create a new auth method instead.',
          )
        }

        rollbackState.push({ name: spec.name, existed: true, priorSpec: mapAccessInfoToSpec(spec, existing) })

        const res = await client.request(`/auth-method-update-${spec.type}`, buildAuthMethodBody(spec, { isUpdate: true }))
        if (!res.ok) {
          throw new Error(`Failed to update auth method "${spec.name}": ${akeylessErrorMessage(res)}`)
        }
      } else {
        rollbackState.push({ name: spec.name, existed: false })

        const res = await client.request(`/auth-method-create-${spec.type}`, buildAuthMethodBody(spec, { isUpdate: false }))
        if (!res.ok) {
          throw new Error(`Failed to create auth method "${spec.name}": ${akeylessErrorMessage(res)}`)
        }
        createdNames.push(spec.name)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} auth method(s) to Akeyless (${baseUrl}): ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedAuthMethods: deployed },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth method deployment failed after ${deployed.length} of ${specs.length} item(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedAuthMethods: deployed },
      rollbackData: { previousState: rollbackState, createdNames },
    }
  }
}

// --- Helpers -------------------------------------------------------------------

export interface LiveAuthMethodGet {
  auth_method_access_id?: string
  description?: string
  delete_protection?: boolean
  access_info?: Record<string, unknown>
}

/** GET /auth-method-get by name. Returns null on a genuine 404 ("does not exist"), throws otherwise. */
export async function getAuthMethod(client: AkeylessClient, name: string): Promise<LiveAuthMethodGet | null> {
  const res = await client.request('/auth-method-get', { name })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to look up auth method "${name}": ${akeylessErrorMessage(res)}`)
  }
  return parseJson<LiveAuthMethodGet>(res.body) ?? {}
}

/** Build the create/update request body for a given auth-method type - kebab-case keys, per the API. */
export function buildAuthMethodBody(spec: AuthMethodSpec, opts: { isUpdate: boolean }): Record<string, unknown> {
  const common: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    'access-expires': spec.accessExpires,
    'bound-ips': spec.boundIps,
    'gw-bound-ips': spec.gwBoundIps,
    'force-sub-claims': spec.forceSubClaims,
    'jwt-ttl': spec.jwtTtl,
    'allowed-client-type': spec.allowedClientType,
    'product-type': spec.productType,
    'audit-logs-claims': spec.auditLogsClaims,
    'expiration-event-in': spec.expirationEventIn,
    delete_protection: boolFlag(spec.deleteProtection),
  }
  if (opts.isUpdate) common['new-name'] = spec.name

  let specific: Record<string, unknown> = {}
  switch (spec.type) {
    case 'aws-iam':
      specific = {
        'bound-aws-account-id': spec.boundAwsAccountId,
        'sts-url': spec.stsUrl,
        'bound-arn': spec.boundArn,
        'bound-role-name': spec.boundRoleName,
        'bound-role-id': spec.boundRoleId,
        'bound-resource-id': spec.boundResourceId,
        'bound-user-name': spec.boundUserName,
        'bound-user-id': spec.boundUserId,
        'unique-identifier': spec.uniqueIdentifierAwsIam,
      }
      break
    case 'azure-ad':
      specific = {
        'bound-tenant-id': spec.boundTenantId,
        issuer: spec.issuerAzureAd,
        'jwks-uri': spec.jwksUri,
        audience: spec.audienceAzureAd,
        'bound-spid': spec.boundSpid,
        'bound-group-id': spec.boundGroupId,
        'bound-sub-id': spec.boundSubId,
        'bound-rg-id': spec.boundRgId,
        'bound-providers': spec.boundProviders,
        'bound-resource-types': spec.boundResourceTypes,
        'bound-resource-names': spec.boundResourceNames,
        'bound-resource-id': spec.boundResourceIdAzureAd,
        'unique-identifier': spec.uniqueIdentifierAzureAd,
      }
      break
    case 'k8s':
      specific = {
        audience: spec.audienceK8s,
        'bound-sa-names': spec.boundSaNames,
        'bound-pod-names': spec.boundPodNames,
        'bound-namespaces': spec.boundNamespaces,
        'public-key': spec.publicKey,
        // Always false: this app never auto-generates a fresh key pair on
        // deploy (that would be non-idempotent). Provide "Public Key" in
        // the canvas to bind a caller-managed key pair.
        'gen-key': 'false',
      }
      break
    case 'oidc':
      specific = {
        issuer: spec.issuerOidc,
        'client-id': spec.clientId,
        'unique-identifier': spec.uniqueIdentifierOidc,
        'allowed-redirect-uri': spec.allowedRedirectUri,
        'required-scopes': spec.requiredScopes,
        'required-scopes-prefix': spec.requiredScopesPrefix,
        audience: spec.audienceOidc,
        'subclaims-delimiters': spec.subclaimsDelimiters,
      }
      // Write-only: only sent when the author actually typed a new secret.
      // Leaving it blank on an existing OIDC auth method keeps the current
      // secret unchanged (Akeyless never returns it, so this app cannot
      // "preserve" it any other way).
      if (spec.clientSecret) specific['client-secret'] = spec.clientSecret
      break
    case 'api-key':
    default:
      specific = {}
  }

  return compactBody({ ...common, ...specific })
}

/**
 * Reconstruct an AuthMethodSpec-shaped rollback snapshot from a live
 * /auth-method-get response, for the fields Akeyless actually returns.
 * Write-only fields (clientSecret) are NOT recoverable - rollback restores
 * every other field, but a secret rotated by this deploy cannot be reverted.
 */
export function mapAccessInfoToSpec(declared: AuthMethodSpec, live: LiveAuthMethodGet): AuthMethodSpec {
  const info = (live.access_info ?? {}) as Record<string, any>
  const base: AuthMethodSpec = {
    ...declared,
    description: live.description ?? '',
    deleteProtection: Boolean(live.delete_protection),
    accessExpires: Number(info.access_expires ?? 0),
    boundIps: splitCsv(info.cidr_whitelist),
    gwBoundIps: splitCsv(info.gw_cidr_whitelist),
    forceSubClaims: Boolean(info.force_sub_claims),
    jwtTtl: Number(info.jwt_ttl ?? 0),
    allowedClientType: Array.isArray(info.allowed_client_type) ? info.allowed_client_type : [],
    productType: Array.isArray(info.product_types) ? info.product_types : [],
    auditLogsClaims: Array.isArray(info.audit_logs_claims) ? info.audit_logs_claims : [],
  }

  const type: AuthMethodType | 'unknown' = detectLiveAuthMethodType(info)
  if (type === 'aws-iam') {
    const r = info.aws_iam_access_rules ?? {}
    return {
      ...base,
      boundAwsAccountId: r.account_id ?? [],
      stsUrl: r.sts_endpoint ?? base.stsUrl,
      boundArn: r.arn ?? [],
      boundRoleName: r.role_name ?? [],
      boundRoleId: r.role_id ?? [],
      boundResourceId: r.resource_id ?? [],
      boundUserName: r.user_name ?? [],
      boundUserId: r.user_id ?? [],
      uniqueIdentifierAwsIam: r.unique_identifier ?? '',
    }
  }
  if (type === 'azure-ad') {
    const r = info.azure_ad_access_rules ?? {}
    return {
      ...base,
      boundTenantId: r.bound_tenant_id ?? '',
      issuerAzureAd: r.issuer ?? '',
      jwksUri: r.jwks_uri ?? '',
      audienceAzureAd: r.audience ?? '',
      boundSpid: r.bound_spid ?? [],
      boundGroupId: r.bound_group_id ?? [],
      boundSubId: r.bound_sub_id ?? [],
      boundRgId: r.bound_rg_id ?? [],
      boundProviders: r.bound_providers ?? [],
      boundResourceTypes: r.bound_resource_types ?? [],
      boundResourceNames: r.bound_resource_names ?? [],
      boundResourceIdAzureAd: r.bound_resource_id ?? [],
      uniqueIdentifierAzureAd: r.unique_identifier ?? '',
    }
  }
  if (type === 'k8s') {
    const r = info.k8s_access_rules ?? {}
    return {
      ...base,
      audienceK8s: r.audience ?? '',
      boundSaNames: r.bound_service_account_names ?? [],
      boundPodNames: r.bound_pod_names ?? [],
      boundNamespaces: r.bound_namespaces ?? [],
      publicKey: r.pub_key ?? '',
    }
  }
  if (type === 'oidc') {
    const r = info.oidc_access_rules ?? {}
    return {
      ...base,
      issuerOidc: r.issuer ?? '',
      clientId: r.client_id ?? '',
      uniqueIdentifierOidc: r.unique_identifier ?? '',
      allowedRedirectUri: r.allowed_redirect_uri ?? [],
      requiredScopes: r.required_scopes ?? [],
      requiredScopesPrefix: r.required_scopes_prefix ?? '',
      audienceOidc: r.audience ?? '',
      subclaimsDelimiters: r.subclaims_delimiters ?? [],
    }
  }
  return base
}

function splitCsv(value: unknown): string[] {
  return typeof value === 'string' && value ? value.split(',').filter(Boolean) : []
}
