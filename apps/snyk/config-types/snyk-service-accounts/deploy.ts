import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, restResult, snykErrorMessage, type SnykClient } from '../../lib/snyk'
import { extractServiceAccountSpecs, saKey, type LiveServiceAccount } from './validate'

export interface ServiceAccountRollbackEntry {
  key: string
  name: string
  existed: boolean
  /** Id of the live service account (set for both created and updated accounts). */
  id?: string
  /** Prior mutable attributes, captured before an update. Never includes a secret. */
  prior?: { name?: string; role_id?: string }
}

/**
 * Deploy Snyk service accounts via the REST (JSON:API) API.
 *
 * Identity is the account name: list /orgs/{org_id}/service_accounts, match on
 * the name, then PATCH an existing account (name, role_id) or POST a new one.
 * auth_type is immutable, so it is only ever sent on create — never on update.
 *
 * SECURITY: creating a service account returns a generated API token / client
 * secret in the response attributes. It is WRITE-ONLY — it is never read out,
 * logged, put in the message/artifacts, or captured for rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — configure the "Organization ID" app setting.' }
  }

  const specs = extractServiceAccountSpecs(ctx.canvas).filter((s) => s.name && s.roleId)
  const rollbackState: ServiceAccountRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listServiceAccounts(client)
    const byName = new Map(
      existing.filter((a) => a.attributes?.name).map((a) => [saKey(a.attributes!.name as string), a]),
    )

    for (const spec of specs) {
      const key = saKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        rollbackState.push({
          key,
          name: spec.name,
          existed: true,
          id: live.id,
          prior: { name: live.attributes?.name, role_id: live.attributes?.role_id },
        })
        const res = await client.rest('PATCH', `${client.restOrgPath()}/service_accounts/${live.id}`, {
          body: { data: { id: live.id, type: 'service_account', attributes: { name: spec.name, role_id: spec.roleId } } },
        })
        if (!res.ok) throw new Error(`Failed to update service account "${spec.name}": ${snykErrorMessage(res)}`)
        updated.push(spec.name)
      } else {
        // auth_type is only sent on create (immutable). TTL only when provided.
        const attributes: Record<string, unknown> = { name: spec.name, auth_type: spec.authType, role_id: spec.roleId }
        if (spec.accessTokenTtlSeconds !== undefined) {
          attributes.access_token_ttl_seconds = spec.accessTokenTtlSeconds
        }
        const res = await client.rest('POST', `${client.restOrgPath()}/service_accounts`, {
          body: { data: { type: 'service_account', attributes } },
        })
        if (!res.ok) throw new Error(`Failed to create service account "${spec.name}": ${snykErrorMessage(res)}`)
        // The response attributes contain a generated token/secret — read ONLY the
        // id; the secret is write-only and is never stored or logged.
        const createdSa = restResult<{ id?: string }>(res)
        rollbackState.push({ key, name: spec.name, existed: false, id: createdSa?.id })
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `Snyk service accounts deployed to ${host}: ${created.length} created, ${updated.length} updated`,
      artifacts: { host, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Service account deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List all service accounts for the org; throws on a non-OK response. */
export async function listServiceAccounts(client: SnykClient): Promise<LiveServiceAccount[]> {
  const res = await client.restGetAll<LiveServiceAccount>(`${client.restOrgPath()}/service_accounts`)
  if (!res.ok) {
    throw new Error(
      `Failed to list service accounts: ${snykErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}
