import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson, sendJson } from '../../lib/vectraApi'
import { enabledFromGet, normalizeBool } from './_shared'

/**
 * Deploy Vectra Match enablement per sensor over the Detect REST API (v2.5, 443):
 *   read (rollback): GET  /vectra-match/enablement?device_serial={serial}
 *   write:            POST /vectra-match/enablement  body { device_serial, desired_state }
 *
 * No create/delete — a sensor's Match state is a boolean toggle, never a resource
 * lifecycle. rollbackData records, per sensor, the prior state (null when unreadable)
 * so rollback can restore it exactly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for match enablement deployment' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ deviceSerial: string; enabled: boolean | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const deviceSerial = String(item.fields.device_serial ?? '').trim()
      if (!deviceSerial) continue

      let priorEnabled: boolean | null = null
      try {
        priorEnabled = enabledFromGet(
          await getJson<unknown>(`${base}/vectra-match/enablement?device_serial=${encodeURIComponent(deviceSerial)}`, headers),
        )
      } catch {
        priorEnabled = null
      }
      previous.push({ deviceSerial, enabled: priorEnabled })

      const desired = normalizeBool(item.fields.enabled)
      await sendJson('POST', `${base}/vectra-match/enablement`, headers, { device_serial: deviceSerial, desired_state: desired })
      applied.push(deviceSerial)
    }

    return {
      success: true,
      message: `Applied Vectra Match enablement for ${applied.length} sensor(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Match enablement deploy failed after ${applied.length} sensor(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
