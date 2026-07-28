import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import { buildAssignments, readAssignments, type AssignmentSpec } from '../../lib/assignments'
import {
  buildProfileBody,
  extractProfileSpecs,
  hasAnyAssignment,
  PROFILE_FIELDS,
  profileKey,
} from './validate'

/** A live windowsFeatureUpdateProfile (only the fields we read/manage). */
export interface LiveFeatureUpdateProfile {
  '@odata.type'?: string
  id?: string
  displayName?: string
  description?: string
  featureUpdateVersion?: string
  rolloutSettings?: Record<string, unknown> | null
  installLatestWindows10OnWindows11IneligibleDevice?: boolean
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
    fields?: Record<string, unknown>
    rolloutSettings?: Record<string, unknown> | null
    assignments?: AssignmentSpec
  }
}

/**
 * Deploy Windows feature update profiles via Microsoft Graph
 * windowsFeatureUpdateProfiles (its OWN top-level collection — NOT
 * deviceConfigurations). Reconciliation is by displayName: page the collection,
 * match the profile name client-side, then PATCH an existing profile by id or POST
 * a new one. Assignments are converged with the `assign` action only when the
 * profile declares targets, so a profile with no canvas assignment leaves any
 * manual assignment alone. Non-destructive: profiles not declared here are left
 * untouched.
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
    const existing = await listFeatureUpdateProfiles(client)
    const byName = new Map(existing.filter((p) => p.displayName).map((p) => [profileKey(p.displayName as string), p]))

    for (const spec of specs) {
      const body = buildProfileBody(spec)
      const live = byName.get(profileKey(spec.name))
      const manageAssignments = hasAnyAssignment(spec.assignments)

      if (live && live.id) {
        const prior = await getFeatureUpdateProfile(client, live.id)
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          managedAssignments: manageAssignments,
          prior: {
            description: prior?.description,
            fields: captureManagedFields(prior),
            rolloutSettings: (prior?.rolloutSettings ?? null) as Record<string, unknown> | null,
            assignments: manageAssignments ? readAssignments(prior?.assignments) : undefined,
          },
        })
        const res = await client.request('PATCH', `/deviceManagement/windowsFeatureUpdateProfiles/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update feature update profile "${spec.name}": ${graphErrorMessage(res)}`)
        if (manageAssignments) await assignProfile(client, live.id, spec.assignments, spec.name)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', '/deviceManagement/windowsFeatureUpdateProfiles', { body })
        if (!res.ok) throw new Error(`Failed to create feature update profile "${spec.name}": ${graphErrorMessage(res)}`)
        const createdProfile = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdProfile?.id, managedAssignments: manageAssignments })
        if (manageAssignments && createdProfile?.id) await assignProfile(client, createdProfile.id, spec.assignments, spec.name)
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `Windows feature update profiles deployed to ${graphHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Feature update profile deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Converge a profile's assignments to the declared set (assign REPLACES all assignments). */
export async function assignProfile(client: IntuneClient, id: string, spec: AssignmentSpec, name: string): Promise<void> {
  const res = await client.request('POST', `/deviceManagement/windowsFeatureUpdateProfiles/${id}/assign`, {
    body: { assignments: buildAssignments(spec) },
  })
  if (!res.ok) throw new Error(`Failed to assign feature update profile "${name}": ${graphErrorMessage(res)}`)
}

/** Snapshot the writable scalar fields off a live profile (for rollback restore). */
export function captureManagedFields(live: LiveFeatureUpdateProfile | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!live) return out
  for (const def of PROFILE_FIELDS) {
    if (def.key in live) out[def.key] = live[def.key]
  }
  return out
}

/** List the tenant's Windows feature update profiles (paged); throws on a non-OK response. */
export async function listFeatureUpdateProfiles(client: IntuneClient): Promise<LiveFeatureUpdateProfile[]> {
  const res = await client.getAll<LiveFeatureUpdateProfile>('/deviceManagement/windowsFeatureUpdateProfiles')
  if (!res.ok) {
    throw new Error(`Failed to list feature update profiles: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET a single profile with its assignments expanded (for drift/health/rollback capture). */
export async function getFeatureUpdateProfile(client: IntuneClient, id: string): Promise<LiveFeatureUpdateProfile | null> {
  const res = await client.request('GET', `/deviceManagement/windowsFeatureUpdateProfiles/${id}`, {
    query: { $expand: 'assignments' },
  })
  if (!res.ok) return null
  return parseJson<LiveFeatureUpdateProfile>(res.body)
}
