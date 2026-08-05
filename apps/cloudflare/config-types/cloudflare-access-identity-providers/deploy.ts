import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  MISSING_ACCOUNT_MESSAGE,
  type CloudflareClient,
} from '../../lib/cloudflare'
import {
  extractIdentityProviderSpecs,
  idpKey,
  parseJsonObject,
  type IdentityProviderSpec,
  type LiveIdentityProvider,
} from './validate'

export interface IdentityProviderRollbackEntry {
  name: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveIdentityProvider
}

/**
 * Deploy Cloudflare Access identity providers via the API (account-scoped).
 *
 * Identity is the IdP `name`: list /access/identity_providers, match on the
 * name, then PUT an existing IdP by id or POST a new one. A `read_only` IdP
 * (Cloudflare-managed, e.g. auto-provisioned by an SSO integration) cannot be
 * updated via the API — deploy fails clearly rather than silently no-op'ing.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  // Account-scoped: without a resolvable account id there is nothing to deploy to.
  if (!(await client.hasAccount())) {
    return { success: false, message: MISSING_ACCOUNT_MESSAGE }
  }

  const specs = extractIdentityProviderSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: IdentityProviderRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listIdentityProviders(client)
    const byKey = new Map(existing.filter((p) => p.name).map((p) => [idpKey(p.name as string), p]))

    for (const spec of specs) {
      const label = spec.name
      const key = idpKey(spec.name)
      const live = byKey.get(key)
      const body = buildPayload(spec)

      if (live && live.id) {
        if (live.read_only) {
          throw new Error(`Identity provider "${label}" is read-only in Cloudflare and cannot be updated via the API`)
        }
        rollbackState.push({ name: spec.name, label, existed: true, id: live.id, prior: live })
        const res = await client.account('PUT', `/access/identity_providers/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update identity provider "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        const res = await client.account('POST', '/access/identity_providers', { body })
        if (!res.ok) throw new Error(`Failed to create identity provider "${label}": ${cloudflareErrorMessage(res)}`)
        const created = cloudflareResult<LiveIdentityProvider>(res)
        if (!created?.id) throw new Error(`Identity provider "${label}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} identity provider(s) to account for "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedProviders: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Identity provider deployment failed after ${deployed.length} of ${specs.length} provider(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedProviders: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all Access identity providers in the account; throws on a non-OK response. */
export async function listIdentityProviders(client: CloudflareClient): Promise<LiveIdentityProvider[]> {
  const res = await client.accountGetAll<LiveIdentityProvider>('/access/identity_providers')
  if (!res.ok) {
    throw new Error(
      `Failed to list identity providers: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Build the create/update body: name, type, provider-specific config, plus any advanced fields. */
export function buildPayload(spec: IdentityProviderSpec): Record<string, unknown> {
  const config = parseJsonObject(spec.configJson).value ?? {}
  const advanced = parseJsonObject(spec.advancedJson).value ?? {}
  return {
    name: spec.name,
    type: spec.type,
    config,
    ...advanced,
  }
}
