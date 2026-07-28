import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import { buildAssignments, readAssignments, type AssignmentSpec } from '../../lib/assignments'
import {
  RING_FIELDS,
  buildRingBody,
  extractRingSpecs,
  hasAnyAssignment,
  ringKey,
  WINDOWS_UPDATE_RING_ODATA_TYPE,
} from './validate'

/** A live deviceConfiguration (only the fields we read/manage). */
export interface LiveDeviceConfig {
  '@odata.type'?: string
  id?: string
  displayName?: string
  description?: string
  assignments?: Array<{ target?: Record<string, unknown> }>
  [key: string]: unknown
}

/** The state captured before a ring is changed, so rollback can restore it. */
export interface RingRollbackEntry {
  name: string
  existed: boolean
  id?: string
  managedAssignments: boolean
  prior?: {
    description?: string
    fields?: Record<string, unknown>
    assignments?: AssignmentSpec
  }
}

/**
 * Deploy Windows Update rings via Graph deviceConfigurations
 * (windowsUpdateForBusinessConfiguration). Reconciliation is by displayName (the
 * ring name is our key): list the tenant's device configurations, filter to the
 * update-ring @odata.type, then PATCH an existing ring by id or POST a new one.
 * Assignments are converged with the `assign` action only when the ring declares
 * targets, so a ring with no canvas assignment leaves any manual assignment alone.
 * Non-destructive: rings not declared here are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractRingSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RingRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listUpdateRings(client)
    const byName = new Map(existing.filter((r) => r.displayName).map((r) => [ringKey(r.displayName as string), r]))

    for (const spec of specs) {
      const body = buildRingBody(spec)
      const live = byName.get(ringKey(spec.name))
      const manageAssignments = hasAnyAssignment(spec.assignments)

      if (live && live.id) {
        const prior = await getUpdateRing(client, live.id)
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          managedAssignments: manageAssignments,
          prior: {
            description: prior?.description,
            fields: captureManagedFields(prior),
            assignments: manageAssignments ? readAssignments(prior?.assignments) : undefined,
          },
        })
        const res = await client.request('PATCH', `/deviceManagement/deviceConfigurations/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update update ring "${spec.name}": ${graphErrorMessage(res)}`)
        if (manageAssignments) await assignRing(client, live.id, spec.assignments, spec.name)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', '/deviceManagement/deviceConfigurations', { body })
        if (!res.ok) throw new Error(`Failed to create update ring "${spec.name}": ${graphErrorMessage(res)}`)
        const createdRing = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdRing?.id, managedAssignments: manageAssignments })
        if (manageAssignments && createdRing?.id) await assignRing(client, createdRing.id, spec.assignments, spec.name)
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `Windows Update rings deployed to ${graphHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Update ring deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Converge a ring's assignments to the declared set (assign REPLACES all assignments). */
export async function assignRing(client: IntuneClient, id: string, spec: AssignmentSpec, name: string): Promise<void> {
  const res = await client.request('POST', `/deviceManagement/deviceConfigurations/${id}/assign`, {
    body: { assignments: buildAssignments(spec) },
  })
  if (!res.ok) throw new Error(`Failed to assign update ring "${name}": ${graphErrorMessage(res)}`)
}

/** Snapshot the writable ring fields off a live config (for rollback restore). */
export function captureManagedFields(live: LiveDeviceConfig | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!live) return out
  for (const def of RING_FIELDS) {
    if (def.key in live) out[def.key] = live[def.key]
  }
  return out
}

/** True when a deviceConfiguration is a Windows Update ring. */
export function isUpdateRing(config: LiveDeviceConfig): boolean {
  return String(config['@odata.type'] ?? '').includes('windowsUpdateForBusinessConfiguration')
}

/** List the tenant's Windows Update rings (filtered from all deviceConfigurations); throws on a non-OK response. */
export async function listUpdateRings(client: IntuneClient): Promise<LiveDeviceConfig[]> {
  const res = await client.getAll<LiveDeviceConfig>('/deviceManagement/deviceConfigurations')
  if (!res.ok) {
    throw new Error(`Failed to list device configurations: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items.filter(isUpdateRing)
}

/** GET a single ring with its assignments expanded (for drift/health/rollback capture). */
export async function getUpdateRing(client: IntuneClient, id: string): Promise<LiveDeviceConfig | null> {
  const res = await client.request('GET', `/deviceManagement/deviceConfigurations/${id}`, { query: { $expand: 'assignments' } })
  if (!res.ok) return null
  return parseJson<LiveDeviceConfig>(res.body)
}
