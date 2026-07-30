import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'
import { findQueryByName, toFleetPlatform, normalizeObserverCanRun, type FleetQuery } from './_shared'

/**
 * Deploy Fleet saved queries via the REST API, upserting by name:
 *   read (rollback): GET   /api/v1/fleet/queries        → find by name (best-effort — miss = new query)
 *   create:          POST  /api/v1/fleet/queries        with the query body
 *   update:          PATCH /api/v1/fleet/queries/{id}   when the name already exists
 *
 * Canvas → Fleet mapping (per query):
 *   name           → name
 *   query          → query (osquery SQL)
 *   description    → description
 *   interval       → interval (seconds)
 *   platform       → platform ('all' → '' = every platform)
 *   observerCanRun → observer_can_run (boolean)
 *
 * rollbackData records the prior query per name (null when it did not exist) so
 * rollback can PATCH it back or DELETE the one we created. Verify the request
 * bodies against a live Fleet (fleetdm) instance.
 */
function buildQueryBody(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    name: String(fields.name ?? '').trim(),
    query: String(fields.query ?? ''),
    description: String(fields.description ?? '').trim(),
    interval: Number(fields.interval),
    platform: toFleetPlatform(fields.platform),
    observer_can_run: normalizeObserverCanRun(fields.observerCanRun),
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for saved-query deployment' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; query: FleetQuery | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = await findQueryByName(base, headers, name)
      previous.push({ name, query: existing })

      const body = buildQueryBody(item.fields)
      if (existing) {
        await sendJson('PATCH', `${base}${FLEET_API_BASE}/queries/${existing.id}`, headers, body)
      } else {
        await sendJson('POST', `${base}${FLEET_API_BASE}/queries`, headers, body)
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} saved query(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Saved-query deploy failed after ${applied.length} query(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
