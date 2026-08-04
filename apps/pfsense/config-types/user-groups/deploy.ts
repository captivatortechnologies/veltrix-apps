import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type PfsenseUserGroup } from '../../lib/pfsenseApi'
import { extractSpecs, groupKey, snapshotUserGroup, toUserGroupBody } from './_shared'

export interface RollbackEntry {
  name: string
  id: number | string | null
  prior: Omit<PfsenseUserGroup, 'id'> | null
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { previous?: RollbackEntry[] } | undefined
    return Array.isArray(data?.previous) ? data!.previous : []
  } catch {
    return []
  }
}

/**
 * Deploy user groups over the pfSense REST API package:
 *   list:    GET  /api/v2/user/groups
 *   create:  POST /api/v2/user/group
 *   update:  PATCH /api/v2/user/group
 *   delete (a group this app created but no longer declares):
 *            DELETE /api/v2/user/group
 * NO apply step — UserGroup is `always_apply` server-side (verified:
 * `local_group_set`/`local_group_del` run synchronously inside create/
 * update/delete), unlike every firewall/NAT/routing/DNS config type in this
 * app.
 *
 * System-scoped groups (`scope: "system"`) are NEVER touched — skipped
 * entirely when matching live groups and never deleted during cleanup.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const auth = await client.authenticate()
  if (auth.error) return { success: false, message: auth.error }

  const specs = extractSpecs(items).filter((s) => s.name)
  const previous: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await client.listUserGroups()
    const liveByName = new Map(live.filter((g) => g.name && g.scope !== 'system').map((g) => [groupKey(g.name), g]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(groupKey(spec.name)) ?? null
      const body = toUserGroupBody(spec)

      if (match && match.id !== undefined) {
        await client.updateUserGroup(match.id, body)
        previous.push({ name: spec.name, id: match.id, prior: snapshotUserGroup(match) })
        updated++
      } else {
        const createdGroup = await client.createUserGroup(body)
        previous.push({ name: spec.name, id: createdGroup.id ?? null, prior: null })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => groupKey(s.name)))
    for (const p of prior) {
      if (p.prior !== null || declaredNames.has(groupKey(p.name)) || p.id === null) continue
      await client.deleteUserGroup(p.id)
      deleted++
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} pfSense user group(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deploy failed after ${created} created, ${updated} updated, ${deleted} removed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous },
    }
  }
}
