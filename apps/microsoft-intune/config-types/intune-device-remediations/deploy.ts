import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import {
  buildAssignRequest,
  buildRemediationBody,
  capturePrior,
  type LiveDeviceHealthScript,
  type RemediationPrior,
  type RemediationSpec,
} from './remediation'
import { extractRemediationSpecs, remediationKey } from './validate'

export interface RemediationRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: RemediationPrior
}

/**
 * Deploy Intune device remediations via Microsoft Graph deviceHealthScripts.
 *
 * Reconciliation is by displayName (Graph does not filter these by name, so the tenant
 * list is paged and matched client-side): PATCH an existing script by id or POST a new
 * one. Script bodies are base64-encoded into detection/remediationScriptContent. Group
 * assignments are converged via the separate assign action (each target wrapped with a
 * run schedule). Non-destructive: scripts not declared here are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractRemediationSpecs(ctx.canvas).filter((s) => s.name && s.detectionScript.trim() !== '')
  const rollbackState: RemediationRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listRemediations(client)
    const byName = new Map(existing.filter((r) => r.displayName).map((r) => [remediationKey(r.displayName as string), r]))

    for (const spec of specs) {
      const live = byName.get(remediationKey(spec.name))

      if (live && live.id) {
        const full = (await getRemediation(client, live.id)) ?? live
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: capturePrior(full) })

        const res = await client.request('PATCH', `/deviceManagement/deviceHealthScripts/${live.id}`, { body: buildRemediationBody(spec) })
        if (!res.ok) throw new Error(`Failed to update remediation "${spec.name}": ${graphErrorMessage(res)}`)
        await assignRemediation(client, live.id, spec)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', '/deviceManagement/deviceHealthScripts', { body: buildRemediationBody(spec) })
        if (!res.ok) throw new Error(`Failed to create remediation "${spec.name}": ${graphErrorMessage(res)}`)
        const createdScript = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdScript?.id })
        if (createdScript?.id) await assignRemediation(client, createdScript.id, spec)
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `Device remediations deployed to ${graphHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Device remediation deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Converge a remediation's assignments to the declared set (an empty spec clears all assignments). */
export async function assignRemediation(client: IntuneClient, id: string, spec: RemediationSpec): Promise<void> {
  const res = await client.request('POST', `/deviceManagement/deviceHealthScripts/${id}/assign`, { body: buildAssignRequest(spec) })
  if (!res.ok) throw new Error(`Failed to assign remediation "${spec.name}": ${graphErrorMessage(res)}`)
}

/** List every device remediation (paged); throws on a non-OK response. */
export async function listRemediations(client: IntuneClient): Promise<LiveDeviceHealthScript[]> {
  const res = await client.getAll<LiveDeviceHealthScript>('/deviceManagement/deviceHealthScripts')
  if (!res.ok) {
    throw new Error(`Failed to list device remediations: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET a single remediation with its script content and assignments expanded (for drift/rollback capture). */
export async function getRemediation(client: IntuneClient, id: string): Promise<LiveDeviceHealthScript | null> {
  const res = await client.request('GET', `/deviceManagement/deviceHealthScripts/${id}`, { query: { $expand: 'assignments' } })
  if (!res.ok) return null
  return parseJson<LiveDeviceHealthScript>(res.body)
}
