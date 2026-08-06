import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage, boolFlag, compactBody, parseJson, type AkeylessClient } from '../../lib/akeyless'
import { extractK8sAuthConfigSpecs, type K8sAuthConfigSpec } from './validate'

export interface LiveK8sAuthConfig {
  access_id?: string
  k8s_host?: string
  k8s_issuer?: string
  cluster_api_type?: string
  disable_iss_validation?: string
  k8s_auth_type?: string
  token_exp?: number
  use_local_ca_jwt?: boolean
}

export interface K8sAuthConfigRollbackEntry {
  name: string
  existed: boolean
}

/**
 * Deploy Akeyless Gateway K8s auth configs. ONE item = ONE config, matched
 * on NAME:
 *   - GET  /gateway-get-k8s-auth-config     (404 -> does not exist yet)
 *   - POST /gateway-create-k8s-auth-config  (new item)
 *   - POST /gateway-update-k8s-auth-config  (existing item - Signing Key
 *     and Kubernetes API Server URL must be resent every time, per the API;
 *     see canvas.yaml header)
 * Never deletes a config absent from this canvas - rollback only deletes
 * what THIS deploy itself created (an update to a pre-existing config
 * cannot be reverted - its Signing Key is write-only on every call, so this
 * app never has a prior value to restore; see rollback.ts).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractK8sAuthConfigSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: K8sAuthConfigRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getK8sAuthConfig(client, spec.name)
      rollbackState.push({ name: spec.name, existed: Boolean(existing) })

      const path = existing ? '/gateway-update-k8s-auth-config' : '/gateway-create-k8s-auth-config'
      const res = await client.request(path, buildBody(spec, { isUpdate: Boolean(existing) }))
      if (!res.ok) {
        throw new Error(`Failed to ${existing ? 'update' : 'create'} K8s auth config "${spec.name}": ${akeylessErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} K8s auth config(s) to Akeyless (${baseUrl}): ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedConfigs: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `K8s auth config deployment failed after ${deployed.length} of ${specs.length} item(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedConfigs: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers -------------------------------------------------------------------

export async function getK8sAuthConfig(client: AkeylessClient, name: string): Promise<LiveK8sAuthConfig | null> {
  const res = await client.request('/gateway-get-k8s-auth-config', { name })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to look up K8s auth config "${name}": ${akeylessErrorMessage(res)}`)
  return parseJson<LiveK8sAuthConfig>(res.body) ?? {}
}

export function buildBody(spec: K8sAuthConfigSpec, opts: { isUpdate: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    'access-id': spec.accessId,
    'signing-key': spec.signingKey,
    'token-exp': Number(spec.tokenExp) || 300,
    'k8s-host': spec.k8sHost,
    'k8s-ca-cert': spec.k8sCaCert,
    'k8s-issuer': spec.k8sIssuer,
    'disable-issuer-validation': boolFlag(spec.disableIssuerValidation),
    'cluster-api-type': spec.clusterApiType,
    'rancher-cluster-id': spec.rancherClusterId,
    'use-local-ca-jwt': spec.useLocalCaJwt,
    'k8s-auth-type': spec.k8sAuthType,
    'k8s-client-certificate': spec.k8sClientCertificate,
  }
  if (opts.isUpdate) body['new-name'] = spec.name
  if (spec.tokenReviewerJwt) body['token-reviewer-jwt'] = spec.tokenReviewerJwt
  if (spec.rancherApiKey) body['rancher-api-key'] = spec.rancherApiKey
  if (spec.k8sClientKey) body['k8s-client-key'] = spec.k8sClientKey

  return compactBody(body)
}
