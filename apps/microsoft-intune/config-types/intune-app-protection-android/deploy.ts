import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import {
  ANDROID_APP_PROTECTION_PATH,
  buildAssignBody,
  buildProtectionBody,
  buildTargetAppsBody,
  capturePriorFields,
  readLiveAssignment,
  readLiveTargetedApps,
  type AndroidAppProtectionSpec,
  type LiveAndroidAppProtection,
} from './appProtection'
import { extractProtectionSpecs, policyKey } from './validate'
import type { AppGroupType } from '../../lib/targetApps'

export interface ProtectionAssignmentGroups {
  includeGroupIds: string[]
  excludeGroupIds: string[]
  allDevices: boolean
  allUsers: boolean
}

export interface ProtectionRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    fields: Record<string, unknown>
    appGroupType: AppGroupType
    targetedApps: string[]
    assignment: ProtectionAssignmentGroups
  }
}

/**
 * Deploy Intune Android app protection (MAM) policies via Graph
 * androidManagedAppProtection. Reconciliation is by displayName (Graph does not
 * filter these by name, so the tenant list is paged and matched client-side):
 * PATCH an existing policy by id or POST a new one, then converge its targeted
 * apps (targetApps action) and group assignment (assign action). Prior state is
 * captured for rollback. Non-destructive: policies not declared here are untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractProtectionSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ProtectionRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listProtections(client)
    const byName = new Map(existing.filter((p) => p.displayName).map((p) => [policyKey(p.displayName as string), p]))

    for (const spec of specs) {
      const live = byName.get(policyKey(spec.name))

      if (live && live.id) {
        const full = (await getProtection(client, live.id)) ?? live
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            fields: capturePriorFields(full),
            appGroupType: (typeof full.appGroupType === 'string' ? full.appGroupType : 'selectedPublicApps') as AppGroupType,
            targetedApps: readLiveTargetedApps(full),
            assignment: readLiveAssignment(full),
          },
        })

        const patch = await client.request('PATCH', `${ANDROID_APP_PROTECTION_PATH}/${live.id}`, { body: buildProtectionBody(spec) })
        if (!patch.ok) throw new Error(`Failed to update app protection policy "${spec.name}": ${graphErrorMessage(patch)}`)

        await convergeTargetAppsAndAssignment(client, live.id, spec)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', ANDROID_APP_PROTECTION_PATH, { body: buildProtectionBody(spec) })
        if (!res.ok) throw new Error(`Failed to create app protection policy "${spec.name}": ${graphErrorMessage(res)}`)
        const createdPolicy = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdPolicy?.id })
        if (createdPolicy?.id) await convergeTargetAppsAndAssignment(client, createdPolicy.id, spec)
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `Android app protection policies deployed to ${graphHost}: ${created.length} created, ${updated.length} updated`,
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

/** Converge a policy's targeted apps then its assignments (both replace the live set). */
async function convergeTargetAppsAndAssignment(client: IntuneClient, id: string, spec: AndroidAppProtectionSpec): Promise<void> {
  await targetApps(client, id, spec)
  await assignPolicy(client, id, spec)
}

/** Set the managed apps this policy targets (targetApps replaces the app list). */
export async function targetApps(client: IntuneClient, id: string, spec: AndroidAppProtectionSpec): Promise<void> {
  const res = await client.request('POST', `${ANDROID_APP_PROTECTION_PATH}/${id}/targetApps`, { body: buildTargetAppsBody(spec) })
  if (!res.ok) throw new Error(`Failed to set targeted apps for "${spec.name}": ${graphErrorMessage(res)}`)
}

/** Converge a policy's assignments to the declared set (assign replaces all assignments). */
export async function assignPolicy(client: IntuneClient, id: string, spec: AndroidAppProtectionSpec): Promise<void> {
  const res = await client.request('POST', `${ANDROID_APP_PROTECTION_PATH}/${id}/assign`, { body: buildAssignBody(spec) })
  if (!res.ok) throw new Error(`Failed to assign app protection policy "${spec.name}": ${graphErrorMessage(res)}`)
}

/** List every Android app protection policy (paged); throws on a non-OK response. */
export async function listProtections(client: IntuneClient): Promise<LiveAndroidAppProtection[]> {
  const res = await client.getAll<LiveAndroidAppProtection>(ANDROID_APP_PROTECTION_PATH)
  if (!res.ok) {
    throw new Error(`Failed to list Android app protection policies: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET a single policy with its apps + assignments expanded (for drift/rollback capture). */
export async function getProtection(client: IntuneClient, id: string): Promise<LiveAndroidAppProtection | null> {
  const res = await client.request('GET', `${ANDROID_APP_PROTECTION_PATH}/${id}`, { query: { $expand: 'apps,assignments' } })
  if (!res.ok) return null
  return parseJson<LiveAndroidAppProtection>(res.body)
}
