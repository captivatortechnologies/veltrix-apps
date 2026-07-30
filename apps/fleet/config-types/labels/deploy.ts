import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'
import { findLabelByName, toFleetPlatform, type FleetLabel } from './_shared'

/**
 * Deploy Fleet dynamic labels via the REST API, upserting by name:
 *   read (rollback): GET   /api/v1/fleet/labels        → find by name (best-effort — miss = new label)
 *   create:          POST  /api/v1/fleet/labels        with the label body
 *   update:          PATCH /api/v1/fleet/labels/{id}   when the name already exists
 *
 * Canvas → Fleet mapping (per label):
 *   name        → name
 *   description → description
 *   query       → query (osquery SQL selector)
 *   platform    → platform ('all' → '' = every platform)
 *
 * rollbackData records the prior label per name (null when it did not exist) so
 * rollback can PATCH it back or DELETE the one we created. Verify the request
 * bodies against a live Fleet (fleetdm) instance.
 */
function buildLabelBody(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    query: String(fields.query ?? ''),
    platform: toFleetPlatform(fields.platform),
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for label deployment' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; label: FleetLabel | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = await findLabelByName(base, headers, name)
      previous.push({ name, label: existing })

      const body = buildLabelBody(item.fields)
      if (existing) {
        await sendJson('PATCH', `${base}${FLEET_API_BASE}/labels/${existing.id}`, headers, body)
      } else {
        await sendJson('POST', `${base}${FLEET_API_BASE}/labels`, headers, body)
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} label(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Label deploy failed after ${applied.length} label(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
