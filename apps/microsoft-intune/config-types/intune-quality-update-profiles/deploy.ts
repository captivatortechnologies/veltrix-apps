import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import { buildAssignments, readAssignments, type AssignmentSpec } from '../../lib/assignments'
import { buildProfileBody, extractProfileSpecs, hasAnyAssignment, profileKey } from './validate'

/** Base path of the quality update profiles collection (its own top-level endpoint). */
export const QUALITY_UPDATE_PROFILES_PATH = '/deviceManagement/windowsQualityUpdateProfiles'

/** A live windowsQualityUpdateProfile (only the fields we read/manage). */
export interface LiveQualityUpdateProfile {
  '@odata.type'?: string
  id?: string
  displayName?: string
  description?: string
  expeditedUpdateSettings?: { qualityUpdateRelease?: string; daysUntilForcedReboot?: number } & Record<string, unknown>
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
    expeditedUpdateSettings?: Record<string, unknown>
    assignments?: AssignmentSpec
  }
}

/**
 * Deploy Windows quality update (expedite) profiles via Graph
 * deviceManagement/windowsQualityUpdateProfiles. Reconciliation is by displayName
 * (the profile name is our key): page the tenant's profiles, match client-side,
 * then PATCH an existing profile by id or POST a new one. Assignments are converged
 * with the `assign` action only when the profile declares targets, so a profile
 * with no canvas assignment leaves any manual assignment alone. Non-destructive:
 * profiles not declared here are left untouched.
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
    const existing = await listQualityUpdateProfiles(client)
    const byName = new Map(existing.filter((p) => p.displayName).map((p) => [profileKey(p.displayName as string), p]))

    for (const spec of specs) {
      const body = buildProfileBody(spec)
      const live = byName.get(profileKey(spec.name))
      const manageAssignments = hasAnyAssignment(spec.assignments)

      if (live && live.id) {
        const prior = await getQualityUpdateProfile(client, live.id)
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          managedAssignments: manageAssignments,
          prior: {
            description: prior?.description,
            expeditedUpdateSettings: captureExpeditedSettings(prior),
            assignments: manageAssignments ? readAssignments(prior?.assignments) : undefined,
          },
        })
        const res = await client.request('PATCH', `${QUALITY_UPDATE_PROFILES_PATH}/${live.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update quality update profile "${spec.name}": ${graphErrorMessage(res)}`)
        if (manageAssignments) await assignProfile(client, live.id, spec.assignments, spec.name)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', QUALITY_UPDATE_PROFILES_PATH, { body })
        if (!res.ok) throw new Error(`Failed to create quality update profile "${spec.name}": ${graphErrorMessage(res)}`)
        const createdProfile = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdProfile?.id, managedAssignments: manageAssignments })
        if (manageAssignments && createdProfile?.id) await assignProfile(client, createdProfile.id, spec.assignments, spec.name)
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `Quality update profiles deployed to ${graphHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Quality update profile deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Converge a profile's assignments to the declared set (assign REPLACES all assignments). */
export async function assignProfile(client: IntuneClient, id: string, spec: AssignmentSpec, name: string): Promise<void> {
  const res = await client.request('POST', `${QUALITY_UPDATE_PROFILES_PATH}/${id}/assign`, {
    body: { assignments: buildAssignments(spec) },
  })
  if (!res.ok) throw new Error(`Failed to assign quality update profile "${name}": ${graphErrorMessage(res)}`)
}

/** Snapshot the prior expeditedUpdateSettings off a live profile (for rollback restore). */
export function captureExpeditedSettings(live: LiveQualityUpdateProfile | null): Record<string, unknown> | undefined {
  const settings = live?.expeditedUpdateSettings
  if (!settings || typeof settings !== 'object') return undefined
  const out: Record<string, unknown> = {}
  if (typeof settings.qualityUpdateRelease === 'string') out.qualityUpdateRelease = settings.qualityUpdateRelease
  if (typeof settings.daysUntilForcedReboot === 'number') out.daysUntilForcedReboot = settings.daysUntilForcedReboot
  return out
}

/** List the tenant's quality update profiles; throws on a non-OK response. */
export async function listQualityUpdateProfiles(client: IntuneClient): Promise<LiveQualityUpdateProfile[]> {
  const res = await client.getAll<LiveQualityUpdateProfile>(QUALITY_UPDATE_PROFILES_PATH)
  if (!res.ok) {
    throw new Error(`Failed to list quality update profiles: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET a single profile with its assignments expanded (for drift/health/rollback capture). */
export async function getQualityUpdateProfile(client: IntuneClient, id: string): Promise<LiveQualityUpdateProfile | null> {
  const res = await client.request('GET', `${QUALITY_UPDATE_PROFILES_PATH}/${id}`, { query: { $expand: 'assignments' } })
  if (!res.ok) return null
  return parseJson<LiveQualityUpdateProfile>(res.body)
}
