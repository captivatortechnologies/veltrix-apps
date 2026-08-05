import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import { buildAssignments, readAssignments, type AssignmentSpec } from '../../lib/assignments'
import { buildProfileBody, extractProfileSpecs, hasAnyAssignment, profileKey, type DriverApprovalType } from './validate'

/** Base path of the driver update profiles collection (its own top-level endpoint). */
export const DRIVER_UPDATE_PROFILES_PATH = '/deviceManagement/windowsDriverUpdateProfiles'

/** A live windowsDriverUpdateProfile (only the fields we read/manage). */
export interface LiveDriverUpdateProfile {
  '@odata.type'?: string
  id?: string
  displayName?: string
  description?: string
  approvalType?: string
  deploymentDeferralInDays?: number
  assignments?: Array<{ target?: Record<string, unknown> }>
  [key: string]: unknown
}

/** The state captured before a profile is changed, so rollback can restore it. */
export interface ProfileRollbackEntry {
  name: string
  existed: boolean
  id?: string
  managedAssignments: boolean
  prior?: {
    description?: string
    approvalType?: DriverApprovalType
    deploymentDeferralInDays?: number
    assignments?: AssignmentSpec
  }
}

/**
 * Deploy Windows driver update profiles via Graph beta
 * deviceManagement/windowsDriverUpdateProfiles. Reconciliation is by displayName
 * (the profile name is our key): page the tenant's profiles, match client-side,
 * then PATCH an existing profile by id or POST a new one. Assignments are
 * converged with the `assign` action only when the profile declares targets, so a
 * profile with no canvas assignment leaves any manual assignment alone.
 * Non-destructive: profiles not declared here are left untouched. Approving or
 * declining specific driver updates found in a profile's live inventory
 * (executeAction / syncInventory) is device-state, not declarative config, and is
 * out of scope for this type.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractProfileSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ProfileRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listDriverUpdateProfiles(client)
    const byName = new Map(existing.filter((p) => p.displayName).map((p) => [profileKey(p.displayName as string), p]))

    for (const spec of specs) {
      const body = buildProfileBody(spec)
      const live = byName.get(profileKey(spec.name))
      const manageAssignments = hasAnyAssignment(spec.assignments)

      if (live && live.id) {
        const prior = await getDriverUpdateProfile(client, live.id)
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          managedAssignments: manageAssignments,
          prior: {
            description: prior?.description,
            approvalType: normalizePriorApprovalType(prior?.approvalType),
            deploymentDeferralInDays: typeof prior?.deploymentDeferralInDays === 'number' ? prior.deploymentDeferralInDays : undefined,
            assignments: manageAssignments ? readAssignments(prior?.assignments) : undefined,
          },
        })
        const res = await client.request('PATCH', `${DRIVER_UPDATE_PROFILES_PATH}/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update driver update profile "${spec.name}": ${graphErrorMessage(res)}`)
        if (manageAssignments) await assignProfile(client, live.id, spec.assignments, spec.name)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', DRIVER_UPDATE_PROFILES_PATH, { body })
        if (!res.ok) throw new Error(`Failed to create driver update profile "${spec.name}": ${graphErrorMessage(res)}`)
        const createdProfile = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdProfile?.id, managedAssignments: manageAssignments })
        if (manageAssignments && createdProfile?.id) await assignProfile(client, createdProfile.id, spec.assignments, spec.name)
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `Driver update profiles deployed to ${graphHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Driver update profile deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Converge a profile's assignments to the declared set (assign REPLACES all assignments). */
export async function assignProfile(client: IntuneClient, id: string, spec: AssignmentSpec, name: string): Promise<void> {
  const res = await client.request('POST', `${DRIVER_UPDATE_PROFILES_PATH}/${id}/assign`, {
    body: { assignments: buildAssignments(spec) },
  })
  if (!res.ok) throw new Error(`Failed to assign driver update profile "${name}": ${graphErrorMessage(res)}`)
}

/** Normalize a live approvalType string to the two-member enum, undefined when unrecognized. */
export function normalizePriorApprovalType(value: unknown): DriverApprovalType | undefined {
  return value === 'manual' || value === 'automatic' ? value : undefined
}

/** List the tenant's driver update profiles; throws on a non-OK response. */
export async function listDriverUpdateProfiles(client: IntuneClient): Promise<LiveDriverUpdateProfile[]> {
  const res = await client.getAll<LiveDriverUpdateProfile>(DRIVER_UPDATE_PROFILES_PATH)
  if (!res.ok) {
    throw new Error(`Failed to list driver update profiles: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET a single profile with its assignments expanded (for drift/health/rollback capture). */
export async function getDriverUpdateProfile(client: IntuneClient, id: string): Promise<LiveDriverUpdateProfile | null> {
  const res = await client.request('GET', `${DRIVER_UPDATE_PROFILES_PATH}/${id}`, { query: { $expand: 'assignments' } })
  if (!res.ok) return null
  return parseJson<LiveDriverUpdateProfile>(res.body)
}
