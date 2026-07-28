import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import type { AssignmentSpec, AssignmentGroups } from '../../lib/assignments'
import {
  APP_CONFIG_PATH,
  buildAssignBody,
  buildConfigBody,
  buildTargetAppsBody,
  hasAnyAssignment,
  readLiveAppGroupType,
  readLiveAssignment,
  readLiveCustomSettings,
  readLiveTargetedApps,
  type AppConfigSpec,
  type AppGroupType,
  type CustomSetting,
  type LiveAppConfig,
  type MamPlatform,
} from './appConfig'
import { extractAppConfigSpecs, policyKey } from './validate'

/** The state captured before a policy is changed, so rollback can restore it. */
export interface AppConfigRollbackEntry {
  name: string
  existed: boolean
  id?: string
  /** Whether THIS deploy managed (replaced) the policy's group assignments. */
  managedAssignments?: boolean
  prior?: {
    description: string
    customSettings: CustomSetting[]
    platform: MamPlatform
    appGroupType: AppGroupType
    targetedApps: string[]
    assignment: AssignmentGroups
  }
}

/**
 * Deploy Intune app configuration policies via Graph
 * targetedManagedAppConfiguration. Reconciliation is by displayName (Graph does not
 * filter these by name, so the tenant collection is paged and matched client-side):
 * PATCH an existing policy by id or POST a new one with its custom settings, then
 * converge the targeted apps (targetApps action) and the group assignment (assign
 * action) — both are bound by SEPARATE actions, never on the body. Prior state is
 * captured for rollback. Non-destructive: policies not declared here are untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractAppConfigSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: AppConfigRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listAppConfigs(client)
    const byName = new Map(existing.filter((p) => p.displayName).map((p) => [policyKey(p.displayName as string), p]))

    for (const spec of specs) {
      const live = byName.get(policyKey(spec.name))
      // Only converge group assignments when the canvas declares targets — an empty
      // spec leaves manual assignments untouched. (targetApps always runs.)
      const manageAssignments = hasAnyAssignment(spec.assignment)

      if (live && live.id) {
        const full = (await getAppConfig(client, live.id)) ?? live
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          managedAssignments: manageAssignments,
          prior: {
            description: typeof full.description === 'string' ? full.description : '',
            customSettings: readLiveCustomSettings(full),
            platform: spec.platform,
            appGroupType: readLiveAppGroupType(full),
            targetedApps: readLiveTargetedApps(full, spec.platform),
            assignment: readLiveAssignment(full),
          },
        })

        const patch = await client.request('PATCH', `${APP_CONFIG_PATH}/${live.id}`, { body: buildConfigBody(spec) })
        if (!patch.ok) throw new Error(`Failed to update app configuration policy "${spec.name}": ${graphErrorMessage(patch)}`)

        await targetApps(client, live.id, spec)
        if (manageAssignments) await assignPolicy(client, live.id, spec.assignment, spec.name)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', APP_CONFIG_PATH, { body: buildConfigBody(spec) })
        if (!res.ok) throw new Error(`Failed to create app configuration policy "${spec.name}": ${graphErrorMessage(res)}`)
        const createdPolicy = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdPolicy?.id, managedAssignments: manageAssignments })
        if (createdPolicy?.id) {
          await targetApps(client, createdPolicy.id, spec)
          if (manageAssignments) await assignPolicy(client, createdPolicy.id, spec.assignment, spec.name)
        }
        created.push(spec.name)
      }
    }

    return {
      success: true,
      message: `App configuration policies deployed to ${graphHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `App configuration policy deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Converge the targeted apps (appGroupType + apps) via the targetApps action. */
export async function targetApps(client: IntuneClient, id: string, spec: AppConfigSpec): Promise<void> {
  const res = await client.request('POST', `${APP_CONFIG_PATH}/${id}/targetApps`, { body: buildTargetAppsBody(spec) })
  if (!res.ok) throw new Error(`Failed to target apps for "${spec.name}": ${graphErrorMessage(res)}`)
}

/** Converge a policy's assignments to the declared set (assign REPLACES all assignments). */
export async function assignPolicy(client: IntuneClient, id: string, spec: AssignmentSpec, name: string): Promise<void> {
  const res = await client.request('POST', `${APP_CONFIG_PATH}/${id}/assign`, { body: buildAssignBody(spec) })
  if (!res.ok) throw new Error(`Failed to assign app configuration policy "${name}": ${graphErrorMessage(res)}`)
}

/** List every app configuration policy (paged); throws on a non-OK response. */
export async function listAppConfigs(client: IntuneClient): Promise<LiveAppConfig[]> {
  const res = await client.getAll<LiveAppConfig>(APP_CONFIG_PATH)
  if (!res.ok) {
    throw new Error(`Failed to list app configuration policies: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET a single policy with its apps + assignments expanded (for drift/rollback capture). */
export async function getAppConfig(client: IntuneClient, id: string): Promise<LiveAppConfig | null> {
  const res = await client.request('GET', `${APP_CONFIG_PATH}/${id}`, { query: { $expand: 'apps,assignments' } })
  if (!res.ok) return null
  return parseJson<LiveAppConfig>(res.body)
}
