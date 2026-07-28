import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import type { AssignmentSpec } from '../../lib/assignments'
import {
  buildAssignBody,
  buildPolicyBody,
  buildTargetAppsBody,
  capturePriorFields,
  hasAnyAssignment,
  readLiveAppGroupType,
  readLiveAssignment,
  readLiveTargetedApps,
  type AppGroupType,
  type IosMamPolicySpec,
  type LiveIosMamPolicy,
} from './iosAppProtection'
import { extractIosMamSpecs, policyKey } from './validate'

/** Assignment groups captured for rollback. */
export interface IosMamAssignmentGroups {
  includeGroupIds: string[]
  excludeGroupIds: string[]
  allDevices: boolean
  allUsers: boolean
}

/** The state captured before a policy is changed, so rollback can restore it. */
export interface IosMamRollbackEntry {
  name: string
  existed: boolean
  id?: string
  /** Whether THIS deploy managed (replaced) the policy's group assignments. */
  managedAssignments?: boolean
  prior?: {
    description: string
    fields: Record<string, unknown>
    appGroupType: AppGroupType
    targetedApps: string[]
    assignment: IosMamAssignmentGroups
  }
}

/**
 * Deploy Intune iOS app protection (MAM) policies via Graph
 * iosManagedAppProtection. Reconciliation is by displayName (Graph does not filter
 * these by name, so the tenant collection is paged and matched client-side): PATCH
 * an existing policy by id or POST a new one with its scalar settings. The managed
 * apps and the group assignment are then converged via their SEPARATE actions —
 * targetApps (apps first) then assign — so the create/PATCH body never carries
 * either. Non-destructive: policies not declared here are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractIosMamSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: IosMamRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listIosMamPolicies(client)
    const byName = new Map(existing.filter((p) => p.displayName).map((p) => [policyKey(p.displayName as string), p]))

    for (const spec of specs) {
      const live = byName.get(policyKey(spec.name))
      // Only converge group assignments when the canvas declares targets — an empty
      // spec leaves manual assignments untouched. (targetApps always runs: the
      // managed app list is the policy's core config, not a group assignment.)
      const manageAssignments = hasAnyAssignment(spec.assignment)

      if (live && live.id) {
        const full = (await getIosMamPolicy(client, live.id)) ?? live
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          managedAssignments: manageAssignments,
          prior: {
            description: typeof full.description === 'string' ? full.description : '',
            fields: capturePriorFields(full),
            appGroupType: readLiveAppGroupType(full),
            targetedApps: readLiveTargetedApps(full),
            assignment: readLiveAssignment(full),
          },
        })

        const patch = await client.request('PATCH', `/deviceAppManagement/iosManagedAppProtections/${live.id}`, {
          body: buildPolicyBody(spec),
        })
        if (!patch.ok) throw new Error(`Failed to update app protection policy "${spec.name}": ${graphErrorMessage(patch)}`)

        await targetApps(client, live.id, spec.appGroupType, spec.targetedApps, spec.name)
        if (manageAssignments) await assignPolicy(client, live.id, spec.assignment, spec.name)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', '/deviceAppManagement/iosManagedAppProtections', {
          body: buildPolicyBody(spec),
        })
        if (!res.ok) throw new Error(`Failed to create app protection policy "${spec.name}": ${graphErrorMessage(res)}`)
        const createdPolicy = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdPolicy?.id, managedAssignments: manageAssignments })
        if (createdPolicy?.id) {
          await targetApps(client, createdPolicy.id, spec.appGroupType, spec.targetedApps, spec.name)
          if (manageAssignments) await assignPolicy(client, createdPolicy.id, spec.assignment, spec.name)
        }
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `iOS app protection policies deployed to ${graphHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `App protection policy deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Converge the protected apps (appGroupType + apps) via the targetApps action. */
export async function targetApps(client: IntuneClient, id: string, appGroupType: AppGroupType, appIds: string[], name: string): Promise<void> {
  const res = await client.request('POST', `/deviceAppManagement/iosManagedAppProtections/${id}/targetApps`, {
    body: buildTargetAppsBody(appGroupType, appIds),
  })
  if (!res.ok) throw new Error(`Failed to target apps for "${name}": ${graphErrorMessage(res)}`)
}

/** Converge a policy's assignments to the declared set (assign REPLACES all assignments). */
export async function assignPolicy(client: IntuneClient, id: string, spec: AssignmentSpec, name: string): Promise<void> {
  const res = await client.request('POST', `/deviceAppManagement/iosManagedAppProtections/${id}/assign`, {
    body: buildAssignBody(spec),
  })
  if (!res.ok) throw new Error(`Failed to assign app protection policy "${name}": ${graphErrorMessage(res)}`)
}

/** List every iOS app protection policy (paged); throws on a non-OK response. */
export async function listIosMamPolicies(client: IntuneClient): Promise<LiveIosMamPolicy[]> {
  const res = await client.getAll<LiveIosMamPolicy>('/deviceAppManagement/iosManagedAppProtections')
  if (!res.ok) {
    throw new Error(`Failed to list iOS app protection policies: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET a single policy with its apps + assignments expanded (for drift/rollback capture). */
export async function getIosMamPolicy(client: IntuneClient, id: string): Promise<LiveIosMamPolicy | null> {
  const res = await client.request('GET', `/deviceAppManagement/iosManagedAppProtections/${id}`, {
    query: { $expand: 'apps,assignments' },
  })
  if (!res.ok) return null
  return parseJson<LiveIosMamPolicy>(res.body)
}
