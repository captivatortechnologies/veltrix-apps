import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson, sendJson } from '../../lib/vectraApi'
import { assignmentsFromList, devicesForUuid, parseDeviceList } from './_shared'

/**
 * Deploy Vectra Match ruleset assignments over the Detect REST API (v2.5, 443):
 *   list:     GET    /vectra-match/assignment                     → every live (uuid, device) mapping
 *   assign:   POST   /vectra-match/assignment  { uuid, device_serials }  (adds; bulk per uuid)
 *   unassign: DELETE /vectra-match/assignment  { uuid, device_serial }   (removes one device)
 *
 * Reconciled as a set per ruleset uuid: devices declared but not live are added in
 * one bulk POST; devices live but not declared are removed one DELETE at a time.
 * rollbackData records, per uuid, exactly which devices this deploy added and
 * removed, so rollback can invert both.
 */
async function listAssignments(base: string, headers: Record<string, string>) {
  try {
    return assignmentsFromList(await getJson<unknown>(`${base}/vectra-match/assignment`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for match assignment deployment' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ uuid: string; added: string[]; removed: string[] }> = []
  const applied: string[] = []

  try {
    const live = await listAssignments(base, headers)

    for (const item of items) {
      const uuid = String(item.fields.ruleset_uuid ?? '').trim()
      if (!uuid) continue

      const declared = new Set(parseDeviceList(item.fields.device_serials))
      const current = devicesForUuid(live, uuid)

      const added = [...declared].filter((d) => !current.has(d))
      const removed = [...current].filter((d) => !declared.has(d))

      if (added.length > 0) {
        await sendJson('POST', `${base}/vectra-match/assignment`, headers, { uuid, device_serials: added })
      }
      for (const deviceSerial of removed) {
        await sendJson('DELETE', `${base}/vectra-match/assignment`, headers, { uuid, device_serial: deviceSerial })
      }

      previous.push({ uuid, added, removed })
      applied.push(uuid)
    }

    return {
      success: true,
      message: `Applied Vectra Match assignments for ${applied.length} ruleset(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Match assignment deploy failed after ${applied.length} ruleset(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
