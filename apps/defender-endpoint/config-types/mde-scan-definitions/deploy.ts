// =============================================================================
// Deploy authenticated (SNMP) network scan definitions via the Defender API.
//
// Reconciliation is upsert-by-name (case-insensitive), since the API assigns
// `id` on create: PATCH the existing definition if a live one with the same
// scanName exists, otherwise POST a new one. It never deletes definitions it
// did not declare — other tools or the portal may own scans in the same tenant.
//
// scanAuthenticationParams is always rebuilt from the canvas and sent on every
// deploy (create AND update) — see validate.ts for why it is treated as
// write-only end to end.
//
// Progress is recorded as we go so a partial failure can be rolled back. Only
// NON-SECRET fields are captured for an updated definition's rollback state —
// see rollback.ts for what that means for undoing a credential-only change.
// =============================================================================

import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage, parseJson, type MdeClient } from '../../lib/mde'
import {
  buildScanDefinitionBody,
  extractScanDefinitionSpecs,
  scanNameKey,
  type LiveMachine,
  type LiveScanDefinition,
  type ScanDefinitionSpec,
} from './validate'

/** The non-secret fields captured before an UPDATE, so rollback can restore them. */
export interface ScanDefinitionPriorState {
  scanName: string
  isActive: boolean
  target: string
  targetType: string
  intervalInHours: number
  scannerMachineId: string
}

/** What rollback needs to undo one deployed scan definition. */
export interface ScanDefinitionRollbackEntry {
  key: string
  scanName: string
  id: string
  /** True when a definition with this name already existed and was UPDATED. */
  existed: boolean
  /** Non-secret pre-deploy state of an updated definition — see rollback.ts. */
  prior?: ScanDefinitionPriorState
}

/** List every scan definition the credential can see. Throws on a non-OK response. */
export async function listScanDefinitions(client: MdeClient): Promise<LiveScanDefinition[]> {
  const res = await client.request('GET', '/DeviceAuthenticatedScanDefinitions')
  if (!res.ok) throw new Error(`Failed to list scan definitions: ${mdeErrorMessage(res)}`)
  return parseJson<{ value?: LiveScanDefinition[] }>(res.body)?.value ?? []
}

/**
 * Resolve the SINGLE machine a scan definition's scanner agent must be. Unlike
 * machine-tags / device-values (which apply to every match), a scan definition
 * has exactly one scanner agent — an ambiguous computer-name match is an error,
 * not "apply to all".
 */
export async function resolveScannerMachine(
  client: MdeClient,
  spec: ScanDefinitionSpec,
): Promise<{ ok: true; machineId: string } | { ok: false; error: string }> {
  if (spec.scannerDeviceType === 'id') {
    const res = await client.request('GET', `/machines/${encodeURIComponent(spec.scannerDevice)}`)
    if (res.status === 404) return { ok: false, error: `scanner device "${spec.scannerDevice}" not found` }
    if (!res.ok) return { ok: false, error: mdeErrorMessage(res) }
    const machine = parseJson<LiveMachine>(res.body)
    if (!machine?.id) return { ok: false, error: `scanner device "${spec.scannerDevice}" not found` }
    return { ok: true, machineId: machine.id }
  }
  const filter = `computerDnsName eq '${spec.scannerDevice.replace(/'/g, "''")}'`
  const res = await client.getAll<LiveMachine>('/machines', { $filter: filter })
  if (res.status === 404 || (res.ok && res.items.length === 0)) {
    return { ok: false, error: `no device matches computer name "${spec.scannerDevice}"` }
  }
  if (!res.ok) return { ok: false, error: mdeErrorMessage({ status: res.status, ok: false, body: res.body }) }
  const matches = res.items.filter((m) => m.id)
  if (matches.length > 1) {
    return { ok: false, error: `computer name "${spec.scannerDevice}" matched ${matches.length} devices — a scan definition needs exactly one; reference it by device id instead` }
  }
  return { ok: true, machineId: matches[0].id as string }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiHost } = built

  const specs = extractScanDefinitionSpecs(ctx.canvas).filter((s) => s.scanName && s.targets.length > 0)
  const rollbackState: ScanDefinitionRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listScanDefinitions(client)
    const byKey = new Map(existing.filter((d) => d.scanName && d.id).map((d) => [scanNameKey(d.scanName as string), d]))

    for (const spec of specs) {
      const label = spec.scanName
      const key = scanNameKey(spec.scanName)
      const prior = byKey.get(key)

      const resolved = await resolveScannerMachine(client, spec)
      if (!resolved.ok) throw new Error(`Failed to resolve scanner device for "${label}": ${resolved.error}`)

      const body = buildScanDefinitionBody(spec, resolved.machineId)

      if (prior && prior.id != null) {
        const res = await client.request('PATCH', `/DeviceAuthenticatedScanDefinitions/${prior.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update scan definition "${label}": ${mdeErrorMessage(res)}`)
        rollbackState.push({
          key,
          scanName: label,
          id: prior.id,
          existed: true,
          prior: {
            scanName: prior.scanName as string,
            isActive: Boolean(prior.isActive),
            target: prior.target ?? '',
            targetType: prior.targetType ?? 'Ip',
            intervalInHours: prior.intervalInHours ?? 24,
            scannerMachineId: prior.scannerAgent?.machineId ?? resolved.machineId,
          },
        })
        updated.push(label)
      } else {
        const res = await client.request('POST', '/DeviceAuthenticatedScanDefinitions', { body })
        if (!res.ok) throw new Error(`Failed to create scan definition "${label}": ${mdeErrorMessage(res)}`)
        const createdDef = parseJson<{ id?: string }>(res.body)
        if (!createdDef?.id) throw new Error(`Scan definition "${label}" was created but returned no id — cannot record it for rollback`)
        rollbackState.push({ key, scanName: label, id: createdDef.id, existed: false })
        created.push(label)
      }
    }

    return {
      success: true,
      message: `Deployed ${specs.length} scan definition(s) to ${apiHost} (${created.length} created, ${updated.length} updated)`,
      artifacts: { apiHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Scan definition deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
