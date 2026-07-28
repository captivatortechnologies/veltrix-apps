import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import { type AssignmentSpec } from '../../lib/assignments'
import {
  buildAssignments,
  buildComplianceBody,
  buildScheduleActionsRequest,
  capturePriorFields,
  capturePriorScheduledActions,
  hasAnyAssignment,
  readLiveAssignment,
  type CompliancePlatform,
  type LiveCompliancePolicy,
  type LiveScheduledActionForRule,
} from './compliance'
import { extractComplianceSpecs, policyKey } from './validate'

export interface ComplianceAssignmentGroups {
  includeGroupIds: string[]
  excludeGroupIds: string[]
  allDevices: boolean
  allUsers: boolean
}

export interface ComplianceRollbackEntry {
  name: string
  existed: boolean
  id?: string
  platform?: CompliancePlatform
  /** Whether THIS deploy managed (replaced) the policy's assignments — only then
   *  does rollback restore the prior assignments. */
  managedAssignments?: boolean
  prior?: {
    fields: Record<string, unknown>
    assignment: ComplianceAssignmentGroups
    /** The policy's scheduled actions (grace period / retire) before this deploy. */
    scheduledActions: Record<string, unknown>[]
  }
}

/**
 * Deploy Intune device compliance policies via Microsoft Graph deviceCompliancePolicies.
 *
 * Reconciliation is by displayName (Graph does not filter these by name reliably, so
 * the tenant list is paged and matched client-side): PATCH an existing policy by id or
 * POST a new one with its per-platform @odata.type + the required scheduledActionsForRule.
 * Scheduled actions and group assignments are converged via their separate actions.
 * Non-destructive: policies not declared here are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractComplianceSpecs(ctx.canvas).filter((s) => s.name && s.platform)
  const rollbackState: ComplianceRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listCompliancePolicies(client)
    const byName = new Map(existing.filter((p) => p.displayName).map((p) => [policyKey(p.displayName as string), p]))

    for (const spec of specs) {
      const platform = spec.platform as CompliancePlatform
      const live = byName.get(policyKey(spec.name))
      // Only converge assignments when the canvas declares targets — an empty spec
      // leaves the policy's assignments (e.g. manual portal ones) untouched.
      const manageAssignments = hasAnyAssignment(spec.assignment)

      if (live && live.id) {
        const full = (await getCompliancePolicy(client, live.id)) ?? live
        const priorScheduled = await getScheduledActions(client, live.id)
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          platform,
          managedAssignments: manageAssignments,
          prior: {
            fields: capturePriorFields(full, platform),
            assignment: readLiveAssignment(full),
            scheduledActions: priorScheduled,
          },
        })

        const patch = await client.request('PATCH', `/deviceManagement/deviceCompliancePolicies/${live.id}`, {
          body: buildComplianceBody(spec, { includeScheduledActions: false }),
        })
        if (!patch.ok) throw new Error(`Failed to update compliance policy "${spec.name}": ${graphErrorMessage(patch)}`)

        const sched = await client.request('POST', `/deviceManagement/deviceCompliancePolicies/${live.id}/scheduleActionsForRules`, {
          body: buildScheduleActionsRequest(spec),
        })
        if (!sched.ok) throw new Error(`Failed to update scheduled actions for "${spec.name}": ${graphErrorMessage(sched)}`)

        if (manageAssignments) await assignPolicy(client, live.id, spec.assignment)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', '/deviceManagement/deviceCompliancePolicies', {
          body: buildComplianceBody(spec, { includeScheduledActions: true }),
        })
        if (!res.ok) throw new Error(`Failed to create compliance policy "${spec.name}": ${graphErrorMessage(res)}`)
        const createdPolicy = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdPolicy?.id, platform, managedAssignments: manageAssignments })
        if (createdPolicy?.id && manageAssignments) await assignPolicy(client, createdPolicy.id, spec.assignment)
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `Compliance policies deployed to ${graphHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Compliance policy deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Converge a policy's assignments to the declared set (a full replace). Only called
 *  when the canvas declares targets — an empty spec never reaches here, so manual
 *  assignments are preserved. */
export async function assignPolicy(client: IntuneClient, id: string, spec: AssignmentSpec): Promise<void> {
  const res = await client.request('POST', `/deviceManagement/deviceCompliancePolicies/${id}/assign`, {
    body: { assignments: buildAssignments(spec) },
  })
  if (!res.ok) throw new Error(`Failed to assign compliance policy: ${graphErrorMessage(res)}`)
}

/** List every compliance policy (paged); throws on a non-OK response. */
export async function listCompliancePolicies(client: IntuneClient): Promise<LiveCompliancePolicy[]> {
  const res = await client.getAll<LiveCompliancePolicy>('/deviceManagement/deviceCompliancePolicies')
  if (!res.ok) {
    throw new Error(`Failed to list compliance policies: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET a single compliance policy with its assignments expanded (for drift/rollback capture). */
export async function getCompliancePolicy(client: IntuneClient, id: string): Promise<LiveCompliancePolicy | null> {
  const res = await client.request('GET', `/deviceManagement/deviceCompliancePolicies/${id}`, { query: { $expand: 'assignments' } })
  if (!res.ok) return null
  return parseJson<LiveCompliancePolicy>(res.body)
}

/**
 * Read a policy's current scheduled actions (grace period / retire), normalized so
 * rollback can replay them. Best-effort: an unreadable schedule yields [] (rollback
 * then simply leaves the deployed schedule in place rather than failing).
 */
export async function getScheduledActions(client: IntuneClient, id: string): Promise<Record<string, unknown>[]> {
  const res = await client.request('GET', `/deviceManagement/deviceCompliancePolicies/${id}/scheduledActionsForRule`, {
    query: { $expand: 'scheduledActionConfigurations' },
  })
  if (!res.ok) return []
  const parsed = parseJson<{ value?: LiveScheduledActionForRule[] }>(res.body)
  return capturePriorScheduledActions(parsed?.value)
}
