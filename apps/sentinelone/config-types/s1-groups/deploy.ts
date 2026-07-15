import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildS1Client,
  MISSING_SCOPE_MESSAGE,
  s1ErrorMessage,
  s1Result,
  type S1Client,
} from '../../lib/s1'
import { extractGroupSpecs, GROUPS_REQUIRE_SITE_SCOPE, isDefaultGroup, type LiveGroup } from './validate'

export interface GroupRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: { name?: string; inherits?: boolean }
}

/**
 * Deploy SentinelOne groups via the Management API (a site-scoped collection).
 *
 * Groups live under a single site: identity is the group NAME within that site.
 * List /groups at the site scope, match on name, then PUT an existing group by id
 * or POST a new one under the site's id. The protected Default Group is never
 * modified. Unlike the other collections, a group's create body carries one
 * `siteId` (read from the site scope) rather than a `filter`.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built
  if (!client.hasScope) return { success: false, message: MISSING_SCOPE_MESSAGE }
  if (client.currentScope !== 'site') return { success: false, message: GROUPS_REQUIRE_SITE_SCOPE }

  const site = resolveSiteId(client)
  if (site.error || !site.siteId) return { success: false, message: site.error ?? GROUPS_REQUIRE_SITE_SCOPE }
  const siteId = site.siteId

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: GroupRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listGroups(client)
    const byName = new Map(existing.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && isDefaultGroup(live)) {
        throw new Error(`Group "${spec.name}" is the site's protected Default Group and cannot be modified`)
      }

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: { name: live.name, inherits: live.inherits ?? true },
        })
        const res = await client.request('PUT', `/groups/${live.id}`, {
          body: { data: { name: spec.name, inherits: spec.inherits } },
        })
        if (!res.ok) throw new Error(`Failed to update group "${spec.name}": ${s1ErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/groups', {
          body: { data: { name: spec.name, siteId, inherits: spec.inherits } },
        })
        if (!res.ok) throw new Error(`Failed to create group "${spec.name}": ${s1ErrorMessage(res)}`)
        const created = firstResult(s1Result<LiveGroup | LiveGroup[]>(res))
        if (!created?.id) throw new Error(`Group "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} group(s) to ${consoleUrl} (site scope): ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Group deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all groups at the configured site scope; throws on a non-OK response. */
export async function listGroups(client: S1Client): Promise<LiveGroup[]> {
  const sq = client.scopeQuery()
  if (sq.error || !sq.query) throw new Error(sq.error ?? 'scope not configured')
  const res = await client.getAll<LiveGroup>('/groups', sq.query)
  if (!res.ok) {
    throw new Error(`Failed to list groups: ${s1ErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/**
 * The single site id a group is created under. Groups create takes ONE `siteId`
 * field (not a scope `filter`), so it is read from the site scope's filter
 * (siteIds[0]). Errors if the app is not configured at the site scope.
 */
export function resolveSiteId(client: S1Client): { siteId: string | null; error: string | null } {
  if (client.currentScope !== 'site') return { siteId: null, error: GROUPS_REQUIRE_SITE_SCOPE }
  const sf = client.scopeFilter()
  if (sf.error || !sf.filter) return { siteId: null, error: sf.error ?? GROUPS_REQUIRE_SITE_SCOPE }
  const siteIds = sf.filter.siteIds
  const siteId = Array.isArray(siteIds) && typeof siteIds[0] === 'string' ? siteIds[0] : null
  if (!siteId) return { siteId: null, error: GROUPS_REQUIRE_SITE_SCOPE }
  return { siteId, error: null }
}

/** POST /groups may return the created object or an array; normalize to the first. */
function firstResult(result: LiveGroup | LiveGroup[] | null): LiveGroup | null {
  if (!result) return null
  return Array.isArray(result) ? result[0] ?? null : result
}
