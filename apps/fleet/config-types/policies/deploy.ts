import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'
import { findPolicyByName, toFleetPlatform, normalizeCritical, type FleetPolicy } from './_shared'

/**
 * Deploy Fleet global policies via the REST API, upserting by name:
 *   read (rollback): GET   /api/v1/fleet/global/policies       → find by name (best-effort — miss = new policy)
 *   create:          POST  /api/v1/fleet/global/policies       with the policy body
 *   update:          PATCH /api/v1/fleet/global/policies/{id}  when the name already exists
 *
 * Canvas → Fleet mapping (per policy):
 *   name        → name
 *   query       → query (osquery SQL check)
 *   description → description
 *   resolution  → resolution
 *   platform    → platform ('all' → '' = every platform)
 *   critical    → critical (boolean; a Fleet Premium field)
 *
 * rollbackData records the prior policy per name (null when it did not exist) so
 * rollback can PATCH it back or delete the one we created. Verify the request
 * bodies against a live Fleet (fleetdm) instance.
 */
function buildPolicyBody(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    name: String(fields.name ?? '').trim(),
    query: String(fields.query ?? ''),
    description: String(fields.description ?? '').trim(),
    resolution: String(fields.resolution ?? '').trim(),
    platform: toFleetPlatform(fields.platform),
    critical: normalizeCritical(fields.critical),
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for global-policy deployment' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; policy: FleetPolicy | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = await findPolicyByName(base, headers, name)
      previous.push({ name, policy: existing })

      const body = buildPolicyBody(item.fields)
      if (existing) {
        await sendJson('PATCH', `${base}${FLEET_API_BASE}/global/policies/${existing.id}`, headers, body)
      } else {
        await sendJson('POST', `${base}${FLEET_API_BASE}/global/policies`, headers, body)
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} global policy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Global-policy deploy failed after ${applied.length} policy(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
