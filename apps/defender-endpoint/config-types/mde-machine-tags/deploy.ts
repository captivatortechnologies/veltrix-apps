// =============================================================================
// Deploy device tags via the Defender API.
//
// Reconciliation is an idempotent, non-destructive per-tag upsert: for each
// declared device we resolve the target machine(s), read their live
// `machineTags`, and POST /api/machines/{id}/tags {Value, Action:'Add'} only for
// tags not already present. It never removes tags it did not add — other tools
// (and manual portal edits) may own tags on the same device.
//
// A device can be referenced by its stable Defender device id (a single
// GET /api/machines/{id}) or by computer name (an OData $filter that may match
// several devices, e.g. after a re-image — the tag is applied to each match). A
// referenced device that is not found (never onboarded, or aged out of the
// retention window) is recorded and skipped rather than failing the whole deploy.
//
// Progress is recorded as we go so a partial failure can be rolled back: each
// entry captures whether the tag was already present (leave it on rollback) or
// was added by this deploy (remove it on rollback).
// =============================================================================

import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage, parseJson, type MdeClient } from '../../lib/mde'
import { extractMachineTagSpecs, tagKey, type LiveMachine, type MachineTagSpec } from './validate'

/** What rollback needs to undo one applied (device, tag) pair. */
export interface MachineTagRollbackEntry {
  key: string
  label: string
  machineId: string
  tag: string
  /** True when the tag was already present (leave on rollback); false when this deploy ADDED it. */
  existed: boolean
}

/** The per-(device, tag) rollback key. */
export function machineTagKey(machineId: string, tag: string): string {
  return `${machineId}::${tagKey(tag)}`
}

/**
 * Resolve the machine(s) a spec targets. By id: a single GET (a 404 yields an
 * empty match). By computer name: an OData $filter that may return 0..n devices.
 */
export async function resolveMachines(
  client: MdeClient,
  spec: MachineTagSpec,
): Promise<{ ok: true; machines: LiveMachine[] } | { ok: false; error: string }> {
  if (spec.deviceType === 'id') {
    const res = await client.request('GET', `/machines/${encodeURIComponent(spec.deviceValue)}`)
    if (res.status === 404) return { ok: true, machines: [] }
    if (!res.ok) return { ok: false, error: mdeErrorMessage(res) }
    const machine = parseJson<LiveMachine>(res.body)
    return { ok: true, machines: machine?.id ? [machine] : [] }
  }
  const filter = `computerDnsName eq '${spec.deviceValue.replace(/'/g, "''")}'`
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

  const specs = extractMachineTagSpecs(ctx.canvas).filter((s) => s.deviceValue && s.tags.length > 0)
  const rollbackState: MachineTagRollbackEntry[] = []
  const applied: string[] = []
  const missingDevices: string[] = []

  try {
    for (const spec of specs) {
      const resolved = await resolveMachines(client, spec)
      if (!resolved.ok) throw new Error(`Failed to resolve device "${spec.deviceValue}": ${resolved.error}`)
      if (resolved.machines.length === 0) {
        missingDevices.push(spec.deviceValue)
        continue
      }

      for (const machine of resolved.machines) {
        const machineId = machine.id as string
        const present = new Set((machine.machineTags ?? []).map(tagKey))
        const deviceLabel = machine.computerDnsName ?? machineId

        for (const tag of spec.tags) {
          const label = `${tag} on ${deviceLabel}`
          const already = present.has(tagKey(tag))
          if (!already) {
            const res = await client.request('POST', `/machines/${machineId}/tags`, { body: { Value: tag, Action: 'Add' } })
            if (!res.ok) throw new Error(`Failed to add tag "${tag}" to ${deviceLabel}: ${mdeErrorMessage(res)}`)
          }
          rollbackState.push({ key: machineTagKey(machineId, tag), label, machineId, tag, existed: already })
          applied.push(label)
        }
      }
    }

    const skipped = missingDevices.length > 0 ? ` (${missingDevices.length} device(s) not found and skipped)` : ''
    return {
      success: true,
      message: `Applied ${applied.length} device tag(s) on ${apiHost}${skipped}`,
      artifacts: { apiHost, applied, missingDevices },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Device tag deployment failed after ${applied.length} tag(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiHost, applied, missingDevices },
      rollbackData: { previousState: rollbackState },
    }
  }
}
