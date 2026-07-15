import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  MISSING_ACCOUNT_MESSAGE,
  type CloudflareClient,
} from '../../lib/cloudflare'
import { extractServiceTokenSpecs, serviceTokenKey, type LiveServiceToken, type ServiceTokenSpec } from './validate'

/**
 * Rollback record for one token.
 *
 * ⚠ SECURITY: this NEVER carries `client_secret`. For created tokens we keep
 * only the server id (so it can be deleted); for updated tokens we keep the
 * prior name/duration (so it can be restored). The write-only secret is never
 * captured.
 */
export interface ServiceTokenRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: { name?: string; duration?: string }
}

/**
 * Deploy Cloudflare Access service tokens via the API (account-scoped).
 *
 * Identity is the token `name`: list /access/service_tokens, match on the name,
 * then PUT an existing token by id or POST a new one. Cloudflare assigns the
 * server id; we key on the name so re-runs update rather than duplicate.
 *
 * ⚠ SECURITY: creating a token returns { id, client_id, client_secret, name }.
 * `client_secret` is shown EXACTLY ONCE and is write-only — this handler
 * deliberately reads only the id and NEVER logs, diffs or stores the secret
 * (not in artifacts, not in rollbackData). Updates use PUT, which changes
 * name/duration only and never rotates or returns the secret.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  // Service tokens are account-scoped: without an account id there is nothing
  // to deploy against.
  if (!(await client.hasAccount())) {
    return { success: false, message: MISSING_ACCOUNT_MESSAGE }
  }

  const specs = extractServiceTokenSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ServiceTokenRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listServiceTokens(client)
    const byKey = new Map(
      existing.filter((t) => t.name).map((t) => [serviceTokenKey(t.name as string), t]),
    )

    for (const spec of specs) {
      const label = spec.name
      const key = serviceTokenKey(spec.name)
      const live = byKey.get(key)

      if (live && live.id) {
        // Update name/duration by id. PUT never rotates or returns the secret.
        rollbackState.push({
          key,
          label,
          existed: true,
          id: live.id,
          prior: { name: live.name, duration: live.duration },
        })
        const res = await client.account('PUT', `/access/service_tokens/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) throw new Error(`Failed to update service token "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        const res = await client.account('POST', '/access/service_tokens', { body: buildPayload(spec) })
        if (!res.ok) throw new Error(`Failed to create service token "${label}": ${cloudflareErrorMessage(res)}`)
        // ⚠ The response also carries `client_secret` (shown once). We read ONLY
        // the id and deliberately never touch, log or persist the secret.
        const created = cloudflareResult<LiveServiceToken>(res)
        if (!created?.id) throw new Error(`Service token "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} service token(s) to the account for zone "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedTokens: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Service token deployment failed after ${deployed.length} of ${specs.length} token(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedTokens: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all Access service tokens in the account; throws on a non-OK response. */
export async function listServiceTokens(client: CloudflareClient): Promise<LiveServiceToken[]> {
  const res = await client.accountGetAll<LiveServiceToken>('/access/service_tokens')
  if (!res.ok) {
    throw new Error(
      `Failed to list service tokens: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Build the create/update body. Never includes a secret — the API generates it. */
function buildPayload(spec: ServiceTokenSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: spec.name }
  if (spec.duration) payload.duration = spec.duration
  return payload
}
