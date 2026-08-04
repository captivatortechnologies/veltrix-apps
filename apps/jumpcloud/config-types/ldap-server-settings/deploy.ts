import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, parseJson, type JumpCloudClient } from '../../lib/jumpcloudApi'
import {
  extractLdapServerSettingsSpecs,
  buildLdapServerBody,
  findLdapServerByName,
  priorFieldsOf,
  type JumpCloudLdapServer,
} from './_shared'

/** One rollback record per applied LDAP server. */
export interface LdapServerSettingsRollbackEntry {
  name: string
  id: string
  /** Prior managed fields, captured before the PATCH so rollback can restore them. */
  prior: Record<string, unknown>
}

export const LDAP_SERVER_NOT_FOUND_MESSAGE = (name: string): string =>
  `LDAP server "${name}" was not found — LDAP-as-a-Service servers are provisioned interactively in the ` +
  'JumpCloud Admin Console (there is no create endpoint in the API); this config type can only update ' +
  'settings on an existing server. Provision it first, then match it here by its exact name.'

/**
 * Deploy JumpCloud LDAP Server settings over the API v2 (/ldapservers/{id}):
 *   list:  GET   /ldapservers                    (paged; match candidates by name)
 *   patch: PATCH /ldapservers/{id}  with { name, user_lockout_action, user_password_expiration_action }
 *
 * There is NO create — a server not found by id or by name fails the deploy with
 * a clear error rather than silently doing nothing. Matching is RENAME-SAFE via
 * the per-item resourceIds map, same as the other JumpCloud config types.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractLdapServerSettingsSpecs(ctx.canvas).filter((s) => s.name)
  const previousState: LdapServerSettingsRollbackEntry[] = []
  const applied: string[] = []
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const liveServers = await listLdapServers(client)

    for (const spec of specs) {
      let existing: JumpCloudLdapServer | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getLdapServerById(client, priorId)
      if (!existing) existing = findLdapServerByName(liveServers, spec.name)
      if (!existing?.id) throw new Error(LDAP_SERVER_NOT_FOUND_MESSAGE(spec.name))

      const serverId = existing.id
      previousState.push({ name: spec.name, id: serverId, prior: priorFieldsOf(existing) })

      const body = buildLdapServerBody(spec)
      const res = await client.request('PATCH', `/ldapservers/${encodeURIComponent(serverId)}`, { body })
      if (!res.ok) throw new Error(`Failed to update LDAP server "${spec.name}": ${jumpCloudErrorMessage(res)}`)

      if (spec.itemId) resourceIds[spec.itemId] = serverId
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied settings to ${applied.length} LDAP server(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousState, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `LDAP Server Settings deploy failed after ${applied.length} of ${specs.length} server(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previousState, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every LDAP server in the org, following pagination. */
export async function listLdapServers(client: JumpCloudClient): Promise<JumpCloudLdapServer[]> {
  const res = await client.listAll<JumpCloudLdapServer>('/ldapservers')
  if (!res.ok) {
    throw new Error(`Failed to list LDAP servers: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch an LDAP server by id, or null on 404 / any non-ok (a stale stored id falls back to name matching). */
export async function getLdapServerById(client: JumpCloudClient, id: string): Promise<JumpCloudLdapServer | null> {
  const res = await client.request('GET', `/ldapservers/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const server = parseJson<JumpCloudLdapServer>(res.body)
  return server?.id ? server : null
}

/**
 * Read the canvas-item-id -> server-id map this canvas stored on its last
 * SUCCEEDED deploy (rollbackData.resourceIds). Best-effort — {} on no prior
 * deploy or a read error.
 */
async function readPriorResourceIds(ctx: DeployContext): Promise<Record<string, string>> {
  try {
    const prior = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const rb = prior?.rollbackData as { resourceIds?: Record<string, string> } | undefined
    return rb?.resourceIds ?? {}
  } catch {
    return {}
  }
}
