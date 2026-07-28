import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import { buildAssignments, readAssignments, type AssignmentSpec } from '../../lib/assignments'
import {
  SCRIPT_MANAGED_FIELDS,
  buildScriptBody,
  extractScriptSpecs,
  hasAnyAssignment,
  scriptKey,
} from './validate'

/** A live deviceManagementScript (only the fields we read/manage). */
export interface LivePlatformScript {
  '@odata.type'?: string
  id?: string
  displayName?: string
  description?: string
  fileName?: string
  /** Base64-encoded PowerShell (returned on a single GET, not on the list). */
  scriptContent?: string
  runAsAccount?: string
  enforceSignatureCheck?: boolean
  runAs32Bit?: boolean
  assignments?: Array<{ target?: Record<string, unknown> }>
  [key: string]: unknown
}

/** The state captured before a script is changed, so rollback can restore it. */
export interface ScriptRollbackEntry {
  name: string
  existed: boolean
  id?: string
  managedAssignments: boolean
  prior?: {
    description?: string
    /** Raw writable Graph fields (scriptContent stays base64) for an exact restore. */
    fields?: Record<string, unknown>
    assignments?: AssignmentSpec
  }
}

/**
 * Deploy Intune platform scripts via Graph deviceManagementScripts. Reconciliation
 * is by displayName (the script name is our key): list the tenant's scripts, then
 * PATCH an existing script by id or POST a new one (scriptContent base64-encoded
 * from the plain canvas text). Assignments are converged with the `assign` action
 * only when the script declares targets, so a script with no canvas assignment
 * leaves any manual assignment alone. Non-destructive: scripts not declared here
 * are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractScriptSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ScriptRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listScripts(client)
    const byName = new Map(existing.filter((s) => s.displayName).map((s) => [scriptKey(s.displayName as string), s]))

    for (const spec of specs) {
      const body = buildScriptBody(spec)
      const live = byName.get(scriptKey(spec.name))
      const manageAssignments = hasAnyAssignment(spec.assignments)

      if (live && live.id) {
        const prior = await getScript(client, live.id)
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
        const res = await client.request('PATCH', `/deviceManagement/deviceManagementScripts/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update platform script "${spec.name}": ${graphErrorMessage(res)}`)
        if (manageAssignments) await assignScript(client, live.id, spec.assignments, spec.name)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', '/deviceManagement/deviceManagementScripts', { body })
        if (!res.ok) throw new Error(`Failed to create platform script "${spec.name}": ${graphErrorMessage(res)}`)
        const createdScript = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdScript?.id, managedAssignments: manageAssignments })
        if (manageAssignments && createdScript?.id) await assignScript(client, createdScript.id, spec.assignments, spec.name)
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `Platform scripts deployed to ${graphHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Platform script deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/**
 * Converge a script's assignments to the declared set (assign REPLACES all
 * assignments). deviceManagementScripts uses the `deviceManagementScriptAssignments`
 * key (each element is `{ target }`) — buildAssignments already returns that shape.
 */
export async function assignScript(client: IntuneClient, id: string, spec: AssignmentSpec, name: string): Promise<void> {
  const res = await client.request('POST', `/deviceManagement/deviceManagementScripts/${id}/assign`, {
    body: { deviceManagementScriptAssignments: buildAssignments(spec) },
  })
  if (!res.ok) throw new Error(`Failed to assign platform script "${name}": ${graphErrorMessage(res)}`)
}

/** Snapshot the writable script fields off a live script (for rollback restore); scriptContent stays base64. */
export function captureManagedFields(live: LivePlatformScript | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!live) return out
  for (const key of SCRIPT_MANAGED_FIELDS) {
    if (key in live) out[key] = live[key]
  }
  return out
}

/** List the tenant's platform scripts (dedicated collection); throws on a non-OK response. */
export async function listScripts(client: IntuneClient): Promise<LivePlatformScript[]> {
  const res = await client.getAll<LivePlatformScript>('/deviceManagement/deviceManagementScripts')
  if (!res.ok) {
    throw new Error(`Failed to list platform scripts: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET a single script with its assignments expanded (returns scriptContent, for drift/rollback capture). */
export async function getScript(client: IntuneClient, id: string): Promise<LivePlatformScript | null> {
  const res = await client.request('GET', `/deviceManagement/deviceManagementScripts/${id}`, { query: { $expand: 'assignments' } })
  if (!res.ok) return null
  return parseJson<LivePlatformScript>(res.body)
}
