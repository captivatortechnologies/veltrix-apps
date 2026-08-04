import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import { buildSecurityFilterBody, extractSecurityFilterSpecs, parseJsonArray, securityFilterKey, toPayload, type SecurityFilterResource } from './_shared'

/**
 * Deploy Security Filters via a JSON:API resource, GET/POST/PATCH/DELETE
 * /api/v2/security_monitoring/configuration/security_filters[/{id}]:
 *   https://docs.datadoghq.com/api/latest/security-monitoring/create-a-security-filter/
 *   https://docs.datadoghq.com/api/latest/security-monitoring/update-a-security-filter/
 *
 * Identity is the filter NAME (case-insensitive). Live filters are listed,
 * matched by name, and:
 *   - a match is UPDATED (PATCH). Its full prior attributes AND its current
 *     `version` are captured first (re-read immediately before writing, like
 *     Security Monitoring Rules) — the update attributes model documents a
 *     `version` field for optimistic concurrency.
 *   - no match is CREATED (POST); the id is recorded so rollback can delete
 *     it.
 *
 * Best-effort protection: if a matched live filter's attributes carry
 * `is_builtin: true`, this app refuses to modify it. UNVERIFIED (flagged):
 * this app's own research on security filters did not confirm a built-in/
 * read-only marker field the way it did for Log Pipelines (`is_read_only`)
 * and Suppressions (`editable`) — the check is defensive and a no-op if the
 * field never appears on a real response.
 */
export interface SecurityFilterRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: SecurityFilterResource
}

const FILTERS_PATH = '/api/v2/security_monitoring/configuration/security_filters'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractSecurityFilterSpecs(ctx.canvas).filter((s) => s.name && s.query)
  const rollbackState: SecurityFilterRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listSecurityFilters(client)
    const byKey = new Map(
      existing.filter((f) => f.attributes?.name).map((f) => [securityFilterKey(f.attributes!.name as string), f]),
    )

    for (const spec of specs) {
      const label = spec.name
      const key = securityFilterKey(spec.name)

      const exclusionFilters = parseJsonArray(spec.exclusionFiltersRaw)
      if (!exclusionFilters.ok) {
        throw new Error(`Filter "${label}": exclusion_filters must be valid JSON — validate this configuration before deploying`)
      }

      const live = byKey.get(key)

      if (live && live.id) {
        const prior = await readSecurityFilter(client, live.id)
        if (prior.attributes?.is_builtin) {
          throw new Error(`Filter "${label}" is Datadog built-in/read-only and cannot be managed`)
        }
        rollbackState.push({ key, label, existed: true, id: live.id, prior })

        const body = buildSecurityFilterBody(spec, exclusionFilters.value ?? [], prior.attributes?.version)
        const res = await client.request('PATCH', `${FILTERS_PATH}/${encodeURIComponent(live.id)}`, { body: toPayload(body) })
        if (!res.ok) throw new Error(`Failed to update filter "${label}": ${datadogErrorMessage(res)}`)
      } else {
        const body = buildSecurityFilterBody(spec, exclusionFilters.value ?? [])
        const res = await client.request('POST', FILTERS_PATH, { body: toPayload(body) })
        if (!res.ok) throw new Error(`Failed to create filter "${label}": ${datadogErrorMessage(res)}`)
        const created = parseJson<{ data?: SecurityFilterResource }>(res.body)
        const id = created?.data?.id
        if (!id) throw new Error(`Filter "${label}" was created but Datadog returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Security Filter(s) to ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedFilters: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Security filter deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedFilters: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / driftDetect) --------------

export async function listSecurityFilters(client: DatadogClient): Promise<SecurityFilterResource[]> {
  // The official listSecurityFilters client exposes no pagination arguments;
  // this endpoint returns the complete configured collection.
  const res = await client.request('GET', FILTERS_PATH)
  if (!res.ok) throw new Error(`Failed to list Security Filters: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ data?: SecurityFilterResource[] }>(res.body)
  return Array.isArray(parsed?.data) ? parsed.data : []
}

export async function readSecurityFilter(client: DatadogClient, id: string): Promise<SecurityFilterResource> {
  const res = await client.request('GET', `${FILTERS_PATH}/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`Failed to read filter ${id}: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ data?: SecurityFilterResource }>(res.body)
  if (!parsed?.data) throw new Error(`Filter ${id} was not found`)
  return parsed.data
}
