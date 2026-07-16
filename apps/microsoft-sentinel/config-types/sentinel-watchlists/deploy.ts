import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSentinelClient,
  armErrorMessage,
  parseJson,
  SENTINEL_API_VERSION,
  type SentinelClient,
  type SentinelResponse,
} from '../../lib/sentinel'
import { extractWatchlistSpecs, type WatchlistSpec } from './validate'

/** State captured per watchlist so a rollback can delete creates and restore updates. */
export interface WatchlistRollbackEntry {
  alias: string
  existed: boolean
  /** Prior metadata only — GET does not return rawContent, so item content cannot be restored. */
  prior?: { etag?: string; properties?: Record<string, unknown> }
}

/**
 * The Microsoft.SecurityInsights Watchlist request body for a spec. Inline CSV
 * (rawContent + contentType text/csv, sourceType Local) bulk-creates items in the
 * same PUT; rawContent is omitted when no CSV is supplied (metadata-only).
 */
export function buildWatchlistBody(spec: WatchlistSpec): unknown {
  const properties: Record<string, unknown> = {
    displayName: spec.displayName,
    provider: spec.provider,
    source: `${spec.alias}.csv`,
    sourceType: 'Local',
    itemsSearchKey: spec.itemsSearchKey,
    contentType: 'text/csv',
    numberOfLinesToSkip: spec.numberOfLinesToSkip,
  }
  if (spec.itemsCsv.trim()) properties.rawContent = spec.itemsCsv
  return { properties }
}

/** GET one watchlist by its alias. */
export function getWatchlist(client: SentinelClient, alias: string): Promise<SentinelResponse> {
  return client.request('GET', client.sentinelPath(`/watchlists/${alias}`), { apiVersion: SENTINEL_API_VERSION })
}

/**
 * Deploy watchlists via ARM. Reconciliation is by the watchlist alias: GET to
 * learn whether it exists (and capture prior metadata for rollback), then PUT
 * (upsert). Watchlist PUT is asynchronous at api-version 2024-09-01, so each PUT
 * is followed by a bounded provisioning-state poll. Watchlists not declared here
 * are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractWatchlistSpecs(ctx.canvas).filter((s) => s.alias)
  const rollbackState: WatchlistRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    for (const spec of specs) {
      const path = client.sentinelPath(`/watchlists/${spec.alias}`)
      const current = await getWatchlist(client, spec.alias)
      let existed = false
      if (current.status === 200) {
        existed = true
        const prior = parseJson<{ etag?: string; properties?: Record<string, unknown> }>(current.body)
        rollbackState.push({ alias: spec.alias, existed: true, prior: { etag: prior?.etag, properties: prior?.properties } })
      } else if (current.status === 404) {
        rollbackState.push({ alias: spec.alias, existed: false })
      } else {
        throw new Error(`Failed to read watchlist "${spec.alias}": ${armErrorMessage(current)}`)
      }

      const res = await client.request('PUT', path, { apiVersion: SENTINEL_API_VERSION, body: buildWatchlistBody(spec) })
      if (!res.ok) throw new Error(`Failed to ${existed ? 'update' : 'create'} watchlist "${spec.alias}": ${armErrorMessage(res)}`)

      // Watchlist PUT is asynchronous — wait for provisioning to reach Succeeded.
      const poll = await client.pollProvisioning(path, SENTINEL_API_VERSION)
      if (!poll.ok) throw new Error(`Watchlist "${spec.alias}" provisioning did not complete: ${poll.error ?? 'unknown'}`)

      ;(existed ? updated : created).push(spec.alias)
    }

    return {
      success: true,
      message: `Watchlists deployed to ${armHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Watchlist deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
