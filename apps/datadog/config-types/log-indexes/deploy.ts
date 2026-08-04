import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import { buildLogIndexBody, extractLogIndexSpecs, parseJsonArray, parseOptionalNumber, type LogIndex } from './_shared'

/**
 * Deploy Log Indexes via GET/POST/PUT/DELETE
 * /api/v1/logs/config/indexes[/{name}]:
 *   https://docs.datadoghq.com/api/latest/logs-indexes/create-an-index/
 *   https://docs.datadoghq.com/api/latest/logs-indexes/update-an-index/
 *
 * Identity is the index's OWN `name` — chosen once and permanent, so this is
 * a DIRECT lookup (GET .../{name}; 404 means absent) rather than
 * list+match-by-name.
 *   - existing: UPDATED (PUT, full-replace) — the whole index body is sent.
 *   - absent: CREATED (POST).
 *
 * Does NOT manage index ORDER (see _shared.ts).
 */
export interface LogIndexRollbackEntry {
  name: string
  existed: boolean
  prior?: LogIndex
}

const INDEXES_PATH = '/api/v1/logs/config/indexes'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractLogIndexSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: LogIndexRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.name

      const exclusionFilters = parseJsonArray(spec.exclusionFiltersRaw)
      const retentionDays = parseOptionalNumber(spec.retentionDaysRaw)
      const dailyLimit = parseOptionalNumber(spec.dailyLimitRaw)
      if (!exclusionFilters.ok || Number.isNaN(retentionDays) || Number.isNaN(dailyLimit)) {
        throw new Error(`Index "${label}": one or more fields are invalid — validate this configuration before deploying`)
      }

      const existing = await getLogIndex(client, spec.name)
      const body = buildLogIndexBody(spec, exclusionFilters.value ?? [], retentionDays, dailyLimit)

      if (existing) {
        rollbackState.push({ name: spec.name, existed: true, prior: existing })
        const res = await client.request('PUT', `${INDEXES_PATH}/${encodeURIComponent(spec.name)}`, { body })
        if (!res.ok) throw new Error(`Failed to update index "${label}": ${datadogErrorMessage(res)}`)
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        const res = await client.request('POST', INDEXES_PATH, { body })
        if (!res.ok) throw new Error(`Failed to create index "${label}": ${datadogErrorMessage(res)}`)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Log Index(es) to ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedIndexes: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Log index deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedIndexes: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / driftDetect) --------------

/** Direct lookup by name. Returns null on 404 (absent); throws on any other error. */
export async function getLogIndex(client: DatadogClient, name: string): Promise<LogIndex | null> {
  const res = await client.request('GET', `${INDEXES_PATH}/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to read index "${name}": ${datadogErrorMessage(res)}`)
  return parseJson<LogIndex>(res.body)
}

/** List every Log Index (used by healthCheck for a cheap reachability probe). */
export async function listLogIndexes(client: DatadogClient): Promise<LogIndex[]> {
  const res = await client.request('GET', INDEXES_PATH)
  if (!res.ok) throw new Error(`Failed to list Log Indexes: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ indexes?: LogIndex[] } | LogIndex[]>(res.body)
  if (Array.isArray(parsed)) return parsed
  return Array.isArray(parsed?.indexes) ? parsed.indexes : []
}
