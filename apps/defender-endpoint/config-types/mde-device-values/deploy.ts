// =============================================================================
// Deploy device values (business criticality) via the Defender API.
//
// Reconciliation is an idempotent per-device set: for each declared device we
// resolve the target machine(s), read their live `deviceValue`, and PATCH
// /api/machines/{id} { deviceValue } only when it differs from the declared
// criticality. `deviceValue` is single valued, so this replaces the prior value
// on the device — the prior value is captured for rollback.
//
// A device can be referenced by its stable Defender device id (a single
// GET /api/machines/{id}) or by computer name (an OData $filter that may match
// several devices — the value is applied to each match). A referenced device
// that is not found is recorded and skipped rather than failing the whole deploy.
//
// Progress is recorded as we go so a partial failure can be rolled back: each
// entry captures the machine's PRIOR value (only for machines actually changed).
// =============================================================================

import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage, parseJson, type MdeClient } from '../../lib/mde'
import { extractDeviceValueSpecs, type DeviceValue, type DeviceValueSpec, type LiveMachine } from './validate'

/** What rollback needs to restore one changed device's prior value. */
export interface DeviceValueRollbackEntry {
  key: string
  label: string
  machineId: string
  previousValue: DeviceValue
  existed: boolean
}

/**
 * Resolve the machine(s) a spec targets. By id: a single GET (a 404 yields an
 * empty match). By computer name: an OData $filter that may return 0..n devices.
 */
export async function resolveMachines(
  client: MdeClient,
  spec: DeviceValueSpec,
): Promise<{ ok: true; machines: LiveMachine[] } | { ok: false; error: string }> {
  if (spec.deviceType === 'id') {
    const res = await client.request('GET', `/machines/${encodeURIComponent(spec.device)}`)
    if (res.status === 404) return { ok: true, machines: [] }
    if (!res.ok) return { ok: false, error: mdeErrorMessage(res) }
    const machine = parseJson<LiveMachine>(res.body)
    return { ok: true, machines: machine?.id ? [machine] : [] }
  }
  const filter = `computerDnsName eq '${spec.device.replace(/'/g, "''")}'`
  const res = await client.getAll<LiveMachine>('/machines', { $filter: filter })
  // The list API returns 404 when nothing matches — that means "no such device",
  // not a transport error, so it resolves to an empty (skippable) match set.
  if (res.status === 404) return { ok: true, machines: [] }
  if (!res.ok) return { ok: false, error: mdeErrorMessage({ status: res.status, ok: false, body: res.body }) }
  return { ok: true, machines: res.items.filter((m) => m.id) }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiHost } = built

  const specs = extractDeviceValueSpecs(ctx.canvas).filter((s) => s.device && s.criticality)
  const rollbackState: DeviceValueRollbackEntry[] = []
  const applied: string[] = []
  const missingDevices: string[] = []

  try {
    for (const spec of specs) {
      const resolved = await resolveMachines(client, spec)
      if (!resolved.ok) throw new Error(`Failed to resolve device "${spec.device}": ${resolved.error}`)
      if (resolved.machines.length === 0) {
        missingDevices.push(spec.device)
        continue
      }

      for (const machine of resolved.machines) {
        const machineId = machine.id as string
        const deviceLabel = machine.computerDnsName ?? machineId
        const previousValue = (machine.deviceValue ?? 'Normal') as DeviceValue
        const label = `${spec.criticality} on ${deviceLabel}`
        if (previousValue !== spec.criticality) {
          const res = await client.request('PATCH', `/machines/${machineId}`, { body: { deviceValue: spec.criticality } })
          if (!res.ok) throw new Error(`Failed to set device value "${spec.criticality}" on ${deviceLabel}: ${mdeErrorMessage(res)}`)
          rollbackState.push({ key: machineId, label, machineId, previousValue, existed: true })
        }
        applied.push(label)
      }
    }

    const skipped = missingDevices.length > 0 ? ` (${missingDevices.length} device(s) not found and skipped)` : ''
    return {
      success: true,
      message: `Applied ${applied.length} device value(s) on ${apiHost}${skipped}`,
      artifacts: { apiHost, applied, missingDevices },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Device value deployment failed after ${applied.length} device(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiHost, applied, missingDevices },
      rollbackData: { previousState: rollbackState },
    }
  }
}
