import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson, type GithubClient } from '../../lib/githubApi'
import {
  desiredFromItem,
  buildRoleBody,
  roleBodyChanges,
  type CustomRepositoryRole,
  type CustomRoleRollbackEntry,
} from './_shared'

/**
 * Deploy custom repository roles over the REST API:
 *   list:   GET   /orgs/{org}/custom-repository-roles          (match by name / prior id)
 *   create: POST  /orgs/{org}/custom-repository-roles
 *   update: PATCH /orgs/{org}/custom-repository-roles/{role_id} (only changed fields)
 *
 * (org, name) is the stable identity. Each item's prior id is loaded from the
 * last successful deploy so a rename-in-place still resolves the same role.
 * rollbackData records, per role, the prior full state (updates) or created id
 * (creates) so rollback can restore or delete it.
 */

async function loadPriorEntries(ctx: DeployContext): Promise<CustomRoleRollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: CustomRoleRollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as CustomRoleRollbackEntry[]) : []
  } catch {
    return []
  }
}

async function listRoles(
  client: GithubClient,
  org: string,
): Promise<{ ok: true; roles: CustomRepositoryRole[] } | { ok: false; reason: string }> {
  const res = await client.listCustomRepositoryRoles(org)
  if (!res.ok) return { ok: false, reason: `${res.status} ${githubErrorMessage(res)}` }
  const roles = parseJson<CustomRepositoryRole[]>(res.body)
  return { ok: true, roles: Array.isArray(roles) ? roles : [] }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  const entries: CustomRoleRollbackEntry[] = []
  const applied: string[] = []
  const skipped: string[] = []
  const failures: string[] = []
  const listCache = new Map<string, CustomRepositoryRole[]>()

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    if (!desired.org || !desired.name) {
      skipped.push(`${desired.org || '(no org)'}/${desired.name || '(no name)'}`)
      continue
    }
    const fullName = `${desired.org}/${desired.name}`

    if (!listCache.has(desired.org)) {
      const listed = await listRoles(client, desired.org)
      if (!listed.ok) {
        skipped.push(`${fullName} (${listed.reason})`)
        continue
      }
      listCache.set(desired.org, listed.roles)
    }
    const roles = listCache.get(desired.org) ?? []

    const priorEntry = item.id ? priorByItem.get(item.id) : undefined
    const live =
      (priorEntry?.id != null ? roles.find((r) => r.id === priorEntry.id) : undefined) ??
      roles.find((r) => (r.name ?? '') === desired.name)

    try {
      if (live?.id != null) {
        entries.push({ itemId: item.id, org: desired.org, name: desired.name, existed: true, id: live.id, prior: live })
        const changes = roleBodyChanges(desired, live)
        if (Object.keys(changes).length > 0) {
          const res = await client.updateCustomRepositoryRole(desired.org, live.id, changes)
          if (!res.ok) throw new Error(`update: ${res.status} ${githubErrorMessage(res)}`)
        }
      } else {
        const res = await client.createCustomRepositoryRole(desired.org, buildRoleBody(desired))
        if (!res.ok) throw new Error(`create: ${res.status} ${githubErrorMessage(res)}`)
        const created = parseJson<CustomRepositoryRole>(res.body)
        entries.push({ itemId: item.id, org: desired.org, name: desired.name, existed: false, id: created?.id })
        if (created?.id != null) roles.push(created)
      }
      applied.push(fullName)
    } catch (error) {
      failures.push(`${fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const skipNote = skipped.length ? ` (skipped ${skipped.length}: ${skipped.join(', ')})` : ''
  if (failures.length > 0) {
    return {
      success: false,
      message: `Applied ${applied.length} role(s); ${failures.length} failed: ${failures.join(' | ')}${skipNote}`,
      artifacts: { applied, skipped, failures },
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Applied ${applied.length} custom repository role(s): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { entries },
  }
}
