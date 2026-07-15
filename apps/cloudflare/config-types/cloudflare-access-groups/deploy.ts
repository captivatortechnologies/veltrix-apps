import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  MISSING_ACCOUNT_MESSAGE,
  type CloudflareClient,
} from '../../lib/cloudflare'
import { extractAccessGroupSpecs, parseJsonArray, type AccessGroupSpec, type LiveAccessGroup } from './validate'

export interface AccessGroupRollbackEntry {
  name: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveAccessGroup
}

/**
 * Deploy Cloudflare Access groups via the API (account-scoped).
 *
 * Identity is the group `name`: list /access/groups, match on the name, then PUT
 * an existing group by id or POST a new one. The include / exclude / require rule
 * sets are JSON arrays supplied verbatim by the user.
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

  const specs = extractAccessGroupSpecs(ctx.canvas).filter((s) => s.name && s.includeJson.trim())
  const rollbackState: AccessGroupRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listAccessGroups(client)
    const byName = new Map(existing.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const label = spec.name
      const body = buildAccessGroupBody(spec)
      const live = byName.get(spec.name)

      if (live && live.id) {
        rollbackState.push({ name: spec.name, label, existed: true, id: live.id, prior: live })
        const res = await client.account('PUT', `/access/groups/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update Access group "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        const res = await client.account('POST', '/access/groups', { body })
        if (!res.ok) throw new Error(`Failed to create Access group "${label}": ${cloudflareErrorMessage(res)}`)
        const created = cloudflareResult<LiveAccessGroup>(res)
        if (!created?.id) throw new Error(`Access group "${label}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Access group(s) to account for "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Access group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / drift) ---

/** List all Access groups in the account; throws on a non-OK response. */
export async function listAccessGroups(client: CloudflareClient): Promise<LiveAccessGroup[]> {
  const res = await client.accountGetAll<LiveAccessGroup>('/access/groups')
  if (!res.ok) {
    throw new Error(`Failed to list Access groups: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** Build the Access group request body; include is always sent, exclude/require only when non-empty. */
export function buildAccessGroupBody(spec: AccessGroupSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    include: parseJsonArray(spec.includeJson).value ?? [],
  }
  const exclude = parseJsonArray(spec.excludeJson).value
  if (exclude && exclude.length > 0) body.exclude = exclude
  const require = parseJsonArray(spec.requireJson).value
  if (require && require.length > 0) body.require = require
  return body
}
