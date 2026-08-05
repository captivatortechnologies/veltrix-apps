import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  parseJson,
  type InsightVMClient,
} from '../../lib/insightvm'
import { extractSonarQuerySpecs, parseFilters, sonarQueryKey, type LiveSonarQuery, type SonarQuerySpec } from './validate'

export interface SonarQueryRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: number
  /** The full prior query document, captured for an update (PUT full-replace). */
  prior?: LiveSonarQuery
}

/**
 * Deploy Rapid7 InsightVM Sonar queries via the Console API.
 *
 * Identity is the name: list /sonar_queries, match on the name, then PUT an
 * existing query by id (full replace) or POST a new one. A Sonar query is a
 * saved search against Rapid7's Project Sonar internet-scan dataset used to
 * discover assets — this manages the saved QUERY only; running it
 * (POST /sonar_queries/search) and its discovered-asset results
 * (GET /sonar_queries/{id}/assets) are one-shot/read actions, not config.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractSonarQuerySpecs(ctx.canvas).filter((s) => s.name && !parseFilters(s.criteriaJson).error)
  const rollbackState: SonarQueryRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listSonarQueries(client)
    const byKey = new Map(
      existing.filter((q) => q.name).map((q) => [sonarQueryKey({ name: q.name as string }), q]),
    )

    for (const spec of specs) {
      const label = spec.name
      const key = sonarQueryKey(spec)
      const live = byKey.get(key)

      if (live && live.id != null) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/sonar_queries/${live.id}`, { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to update Sonar query "${label}": ${insightVMErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/sonar_queries', { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to create Sonar query "${label}": ${insightVMErrorMessage(res)}`)
        const created = parseJson<{ id?: number }>(res.body)
        if (created?.id == null) throw new Error(`Sonar query "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Sonar quer${deployed.length === 1 ? 'y' : 'ies'} to ${consoleUrl}: ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedSonarQueries: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sonar query deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedSonarQueries: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/**
 * List all Sonar queries. GET /sonar_queries takes no page/size parameters, so
 * this issues a single request and tolerates either a HAL `{ resources }`
 * envelope or a bare array response.
 */
export async function listSonarQueries(client: InsightVMClient): Promise<LiveSonarQuery[]> {
  const res = await client.request('GET', '/sonar_queries')
  if (!res.ok) {
    throw new Error(`Failed to list Sonar queries: ${insightVMErrorMessage(res)}`)
  }
  const parsed = parseJson<unknown>(res.body)
  if (Array.isArray(parsed)) return parsed as LiveSonarQuery[]
  const hal = parsed as { resources?: unknown[] } | null
  return Array.isArray(hal?.resources) ? (hal!.resources as LiveSonarQuery[]) : []
}

function buildBody(spec: SonarQuerySpec): Record<string, unknown> {
  const filters = parseFilters(spec.criteriaJson).value ?? []
  return { name: spec.name, criteria: { filters } }
}
