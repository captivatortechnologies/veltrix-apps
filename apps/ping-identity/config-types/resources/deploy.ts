import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage, type PingOneClient } from '../../lib/pingOne'
import {
  buildResourceBody,
  buildScopeBody,
  extractResourceSpecs,
  findResourceByName,
  isCustomResource,
  parseScopesJson,
  scopeKey,
  type LiveResource,
  type LiveScope,
  type RawScopeJson,
} from './_shared'

/**
 * Deploy Resources + Scopes via the PingOne Platform API:
 *   GET/POST/PUT/DELETE /resources[/{id}]                (parent, matched by name)
 *   GET/POST/PUT/DELETE /resources/{id}/scopes[/{id}]     (child, matched by name)
 *
 * A LIVE resource whose `type !== 'CUSTOM'` (PingOne's built-in OpenID
 * Connect / PingOne API resources) is PROTECTED: it is never created, PUT,
 * or deleted, and its scopes are never reconciled either - the resource is
 * recorded in rollbackData as `protected: true` purely so status reporting
 * and rollback both see it was intentionally left alone.
 *
 * For every other (CUSTOM) resource: a matched resource is PUT (attributes
 * only - `type` is never sent); an unmatched one is POST'd (PingOne only
 * ever creates CUSTOM resources). Its scopes are then fully synced: a
 * matched scope is PUT, an unmatched one is POST'd, and a LIVE scope no
 * longer declared in the item's Scopes array is DELETED (mirrors this app's
 * Datadog Sensitive Data Scanner "declare the complete set" rule model).
 */
export interface UpdatedScopeRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: LiveScope
}

export interface DeletedScopeRollbackEntry {
  name: string
  priorBody: LiveScope
}

export interface ScopeRollback {
  updated: UpdatedScopeRollbackEntry[]
  deleted: DeletedScopeRollbackEntry[]
}

export interface ResourceRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: LiveResource
  protected: boolean
  scopeRollback: ScopeRollback
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, environmentId } = built

  const specs = extractResourceSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ResourceRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []
  const protectedNames: string[] = []

  try {
    const liveResources = await listResources(client)

    for (const spec of specs) {
      const scopesParsed = parseScopesJson(spec.scopesRaw)
      if (!scopesParsed.ok) {
        throw new Error(`Resource "${spec.name}": scopes must be valid JSON - validate this configuration before deploying`)
      }
      const declaredScopes = scopesParsed.value ?? []

      const liveResource = findResourceByName(liveResources, spec.name)

      if (liveResource && liveResource.id && !isCustomResource(liveResource)) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: liveResource.id,
          protected: true,
          scopeRollback: { updated: [], deleted: [] },
        })
        protectedNames.push(spec.name)
        continue
      }

      let resourceId: string
      let resourceExisted: boolean
      let priorResource: LiveResource | undefined

      if (liveResource && liveResource.id) {
        resourceId = liveResource.id
        resourceExisted = true
        priorResource = liveResource
        const res = await client.request('PUT', `/resources/${encodeURIComponent(resourceId)}`, {
          body: buildResourceBody(spec),
        })
        if (!res.ok) throw new Error(`Failed to update resource "${spec.name}": ${pingOneErrorMessage(res)}`)
      } else {
        resourceExisted = false
        const res = await client.request('POST', '/resources', { body: buildResourceBody(spec) })
        if (!res.ok) throw new Error(`Failed to create resource "${spec.name}": ${pingOneErrorMessage(res)}`)
        const created = parseJson<LiveResource>(res.body)
        if (!created?.id) throw new Error(`Resource "${spec.name}" was created but PingOne returned no id`)
        resourceId = created.id
        createdIds.push(resourceId)
      }

      // Reconcile this resource's scopes. A just-created resource has no live
      // scopes yet, so skip the read. Declared scopes are created/updated;
      // any live scope not in the declared set is pruned (deleted).
      const liveScopes = resourceExisted ? await listScopes(client, resourceId) : []
      const liveScopeByKey = new Map(
        liveScopes.filter((s) => s.name).map((s) => [scopeKey(s.name as string), s]),
      )

      const updated: UpdatedScopeRollbackEntry[] = []
      const deleted: DeletedScopeRollbackEntry[] = []
      const declaredKeys = new Set<string>()

      for (const raw of declaredScopes) {
        const scopeName = typeof raw.name === 'string' ? raw.name.trim() : ''
        if (!scopeName) continue
        const sKey = scopeKey(scopeName)
        declaredKeys.add(sKey)
        const body = buildScopeBody(raw)
        const liveScope = liveScopeByKey.get(sKey)

        if (liveScope && liveScope.id) {
          updated.push({ name: scopeName, existed: true, id: liveScope.id, prior: liveScope })
          const res = await client.request('PUT', `/resources/${resourceId}/scopes/${encodeURIComponent(liveScope.id)}`, { body })
          if (!res.ok) {
            throw new Error(`Failed to update scope "${scopeName}" on resource "${spec.name}": ${pingOneErrorMessage(res)}`)
          }
        } else {
          const res = await client.request('POST', `/resources/${resourceId}/scopes`, { body })
          if (!res.ok) {
            throw new Error(`Failed to create scope "${scopeName}" on resource "${spec.name}": ${pingOneErrorMessage(res)}`)
          }
          const created = parseJson<LiveScope>(res.body)
          if (!created?.id) {
            throw new Error(`Scope "${scopeName}" on resource "${spec.name}" was created but PingOne returned no id`)
          }
          updated.push({ name: scopeName, existed: false, id: created.id })
        }
      }

      for (const [sKey, liveScope] of liveScopeByKey) {
        if (declaredKeys.has(sKey) || !liveScope.id) continue
        const res = await client.request('DELETE', `/resources/${resourceId}/scopes/${encodeURIComponent(liveScope.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete scope "${liveScope.name}" on resource "${spec.name}": ${pingOneErrorMessage(res)}`)
        }
        deleted.push({ name: String(liveScope.name ?? sKey), priorBody: liveScope })
      }

      rollbackState.push({
        name: spec.name,
        existed: resourceExisted,
        id: resourceId,
        prior: priorResource,
        protected: false,
        scopeRollback: { updated, deleted },
      })
      deployed.push(spec.name)
    }

    const protectedNote = protectedNames.length
      ? ` (${protectedNames.length} built-in/protected resource(s) left untouched: ${protectedNames.join(', ')})`
      : ''

    return {
      success: true,
      message: `Deployed ${deployed.length} Resource(s) to PingOne environment ${environmentId}: ${deployed.join(', ')}${protectedNote}`,
      artifacts: { environmentId, deployedResources: deployed, protectedResources: protectedNames },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Resources deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { environmentId, deployedResources: deployed, protectedResources: protectedNames },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with validate / rollback / healthCheck / driftDetect) ------------

export async function listResources(client: PingOneClient): Promise<LiveResource[]> {
  const res = await client.getAll<LiveResource>('/resources', 'resources')
  if (!res.ok) throw new Error(`Failed to list resources: ${pingOneErrorMessage(res)}`)
  return res.items
}

export async function listScopes(client: PingOneClient, resourceId: string): Promise<LiveScope[]> {
  const res = await client.getAll<LiveScope>(`/resources/${encodeURIComponent(resourceId)}/scopes`, 'scopes')
  if (!res.ok) throw new Error(`Failed to list scopes for resource ${resourceId}: ${pingOneErrorMessage(res)}`)
  return res.items
}
