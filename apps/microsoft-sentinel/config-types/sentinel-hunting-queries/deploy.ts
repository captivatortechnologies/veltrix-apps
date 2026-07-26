import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSentinelClient,
  armErrorMessage,
  parseJson,
  SAVED_SEARCH_API_VERSION,
  type SentinelClient,
  type SentinelResponse,
} from '../../lib/sentinel'
import { extractSavedSearchSpecs, type SavedSearchSpec } from './validate'

/** The default Log Analytics query-language version for a saved search. */
const SAVED_SEARCH_VERSION = 2

/** State captured per saved search so a rollback can delete creates and restore updates. */
export interface SavedSearchRollbackEntry {
  name: string
  savedSearchId: string
  existed: boolean
  prior?: { properties?: Record<string, unknown> }
}

/**
 * The Microsoft.OperationalInsights SavedSearch request body for a spec. When
 * updating an existing saved search, etag "*" is sent to override it (the service
 * requires "*" or the current etag to overwrite). functionAlias/functionParameters
 * are omitted when empty (a plain saved search, not a function).
 */
export function buildSavedSearchBody(spec: SavedSearchSpec, existed: boolean): unknown {
  const properties: Record<string, unknown> = {
    category: spec.category,
    displayName: spec.name,
    query: spec.query,
    version: SAVED_SEARCH_VERSION,
  }
  if (spec.functionAlias) {
    properties.functionAlias = spec.functionAlias
    if (spec.functionParameters) properties.functionParameters = spec.functionParameters
  }
  const body: Record<string, unknown> = { properties }
  if (existed) body.etag = '*'
  return body
}

/** GET one saved search by its savedSearchId. */
export function getSavedSearch(client: SentinelClient, savedSearchId: string): Promise<SentinelResponse> {
  return client.request('GET', client.workspaceChildPath(`/savedSearches/${savedSearchId}`), {
    apiVersion: SAVED_SEARCH_API_VERSION,
  })
}

/**
 * Deploy hunting queries / saved searches via ARM. Reconciliation is by the
 * deterministic savedSearchId (slug of the name): GET to learn whether it exists
 * (and capture prior state for rollback), then PUT (upsert). Saved searches not
 * declared here are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractSavedSearchSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: SavedSearchRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    for (const spec of specs) {
      const path = client.workspaceChildPath(`/savedSearches/${spec.savedSearchId}`)
      const current = await getSavedSearch(client, spec.savedSearchId)
      let existed = false
      if (current.status === 200) {
        existed = true
        const prior = parseJson<{ properties?: Record<string, unknown> }>(current.body)
        rollbackState.push({ name: spec.name, savedSearchId: spec.savedSearchId, existed: true, prior: { properties: prior?.properties } })
      } else if (current.status === 404) {
        rollbackState.push({ name: spec.name, savedSearchId: spec.savedSearchId, existed: false })
      } else {
        throw new Error(`Failed to read saved search "${spec.name}": ${armErrorMessage(current)}`)
      }

      const res = await client.request('PUT', path, { apiVersion: SAVED_SEARCH_API_VERSION, body: buildSavedSearchBody(spec, existed) })
      if (!res.ok) throw new Error(`Failed to ${existed ? 'update' : 'create'} saved search "${spec.name}": ${armErrorMessage(res)}`)
      ;(existed ? updated : created).push(spec.name)
    }

    return {
      success: true,
      message: `Hunting queries deployed to ${armHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Hunting query deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
