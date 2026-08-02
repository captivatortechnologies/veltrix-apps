import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage, parseJson, type DatadogClient } from '../../lib/datadogApi'
import {
  buildSuppressionBody,
  extractSuppressionSpecs,
  isNonEditableSuppression,
  parseEpochMs,
  suppressionKey,
  toCreatePayload,
  toUpdatePayload,
  type SuppressionResource,
} from './_shared'

/**
 * Deploy Security Monitoring Suppression rules via a JSON:API resource,
 * GET/POST/PATCH/DELETE /api/v2/security_monitoring/configuration/suppressions[/{id}]:
 *   https://docs.datadoghq.com/api/latest/security-monitoring/get-all-suppression-rules/
 *   https://docs.datadoghq.com/api/latest/security-monitoring/create-a-suppression-rule/
 *   https://docs.datadoghq.com/api/latest/security-monitoring/update-a-suppression-rule/
 *
 * Identity is the suppression NAME (case-insensitive). Live suppressions are
 * listed, matched by name, and:
 *   - a match is UPDATED (PATCH). The endpoint supports a true partial patch,
 *     but this app always sends every managed attribute so the effect is a
 *     full replace of the declared state. Its full prior attributes are
 *     captured for rollback FIRST.
 *   - PROTECTED: a matched suppression that is not `editable` is NEVER
 *     modified — the deploy fails loudly. Pick a different name.
 *   - no match is CREATED (POST); the id is recorded so rollback can delete
 *     it.
 * No optimistic-concurrency `version` field is sent on write — Datadog's docs
 * do not document one as required for this API (unlike Security Monitoring
 * Rules).
 */
export interface SuppressionRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: SuppressionResource
}

const SUPPRESSIONS_PATH = '/api/v2/security_monitoring/configuration/suppressions'
const PAGE_SIZE = 100
const MAX_PAGES = 50

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractSuppressionSpecs(ctx.canvas).filter((s) => s.name && s.ruleQuery)
  const rollbackState: SuppressionRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listSuppressions(client)
    const byKey = new Map(
      existing.filter((r) => r.attributes?.name).map((r) => [suppressionKey(r.attributes!.name as string), r]),
    )

    for (const spec of specs) {
      const label = spec.name
      const key = suppressionKey(spec.name)

      const start = parseEpochMs(spec.startDateRaw)
      const expiration = parseEpochMs(spec.expirationDateRaw)
      if (Number.isNaN(start) || Number.isNaN(expiration)) {
        throw new Error(`Suppression "${label}": start_date/expiration_date must be valid numbers — validate this configuration before deploying`)
      }
      const body = buildSuppressionBody(spec, start, expiration)

      const live = byKey.get(key)

      if (live && live.id) {
        if (isNonEditableSuppression(live)) {
          throw new Error(`Suppression "${label}" is not editable (attributes.editable === false) — it cannot be modified by this app.`)
        }
        const prior = await readSuppression(client, live.id)
        rollbackState.push({ key, label, existed: true, id: live.id, prior })

        const res = await client.request('PATCH', `${SUPPRESSIONS_PATH}/${encodeURIComponent(live.id)}`, {
          body: toUpdatePayload(live.id, body),
        })
        if (!res.ok) throw new Error(`Failed to update suppression "${label}": ${datadogErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', SUPPRESSIONS_PATH, { body: toCreatePayload(body) })
        if (!res.ok) throw new Error(`Failed to create suppression "${label}": ${datadogErrorMessage(res)}`)
        const created = parseJson<{ data?: SuppressionResource }>(res.body)
        const id = created?.data?.id
        if (!id) throw new Error(`Suppression "${label}" was created but Datadog returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Suppression Rule(s) to ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedSuppressions: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Suppression rule deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedSuppressions: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers (shared with rollback / healthCheck / driftDetect) --------------

/** List every suppression rule, paging via `page[size]` / `page[number]` (JSON:API `{ data: [...] }`). */
export async function listSuppressions(client: DatadogClient): Promise<SuppressionResource[]> {
  const all: SuppressionResource[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.request('GET', SUPPRESSIONS_PATH, {
      query: { 'page[size]': PAGE_SIZE, 'page[number]': page },
    })
    if (!res.ok) throw new Error(`Failed to list Suppression Rules: ${datadogErrorMessage(res)}`)
    const parsed = parseJson<{ data?: SuppressionResource[] }>(res.body)
    const batch = Array.isArray(parsed?.data) ? (parsed?.data as SuppressionResource[]) : []
    if (batch.length === 0) break
    all.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return all
}

/** Read one suppression's full, authoritative resource. Throws on error. */
export async function readSuppression(client: DatadogClient, id: string): Promise<SuppressionResource> {
  const res = await client.request('GET', `${SUPPRESSIONS_PATH}/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`Failed to read suppression ${id}: ${datadogErrorMessage(res)}`)
  const parsed = parseJson<{ data?: SuppressionResource }>(res.body)
  if (!parsed?.data) throw new Error(`Suppression ${id} was not found`)
  return parsed.data
}
