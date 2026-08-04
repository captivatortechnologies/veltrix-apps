import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCheckpointClient,
  checkpointErrorMessage,
  isNotFoundError,
  MAX_PAGE_SIZE,
  type CheckpointClient,
} from '../../lib/checkpointApi'
import { liveTagNames } from '../lib/checkpointShared'
import { extractGroupSpecs, groupKey, liveMemberNames, type GroupSpec, type LiveGroup } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the group existed before THIS deploy — set-group (true) vs add-group (false). */
  existed: boolean
  prior?: Record<string, unknown>
}

/** Build the add-group / set-group request body for a declared spec. */
export function buildGroupBody(spec: GroupSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, members: spec.members }
  if (spec.comments) body.comments = spec.comments
  if (spec.color) body.color = spec.color
  if (spec.tags.length > 0) body.tags = spec.tags
  return body
}

/** Snapshot a live group's managed fields into a set-group-compatible body, for rollback. */
export function snapshotLive(live: LiveGroup): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name, members: liveMemberNames(live.members) }
  if (live.comments) body.comments = live.comments
  if (live.color) body.color = live.color
  const tags = liveTagNames(live.tags)
  if (tags.length > 0) body.tags = tags
  return body
}

/** Page through show-groups (max 500/page) and return every group in the domain. */
export async function listAllGroups(client: CheckpointClient): Promise<LiveGroup[]> {
  const groups: LiveGroup[] = []
  let offset = 0
  for (;;) {
    const res = await client.call<{ objects?: LiveGroup[]; total?: number }>('show-groups', {
      limit: MAX_PAGE_SIZE,
      offset,
      'details-level': 'standard',
    })
    if (!res.ok) throw new Error(`show-groups failed: ${checkpointErrorMessage(res)}`)
    const objects = res.data?.objects ?? []
    groups.push(...objects)
    const total = res.data?.total ?? objects.length
    offset += objects.length
    if (objects.length === 0 || offset >= total) break
  }
  return groups
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Deploy Check Point network groups via the Management API. Identity is the
 * group `name`: list the management database (show-groups), match on the
 * name, and add-group (create) / set-group (update, members sent in full so
 * a declared member removal is honored) each declared group. Groups THIS app
 * created previously but no longer declares are removed (delete-group). The
 * whole reconciliation runs inside ONE session: publish on success, discard
 * the whole session on any error.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await listAllGroups(client)
    const liveByName = new Map(live.filter((g) => g.name).map((g) => [groupKey(g.name as string), g]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(groupKey(spec.name)) ?? null
      const body = buildGroupBody(spec)

      if (match) {
        const res = await client.call('set-group', body)
        if (!res.ok) throw new Error(`set-group "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const res = await client.call('add-group', body)
        if (!res.ok) throw new Error(`add-group "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => groupKey(s.name)))
    for (const p of prior) {
      if (p.existed || declaredNames.has(groupKey(p.name))) continue
      const res = await client.call('delete-group', { name: p.name })
      if (!res.ok && !isNotFoundError(res)) {
        throw new Error(`delete-group "${p.name}" failed: ${checkpointErrorMessage(res)}`)
      }
      deleted++
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message:
        `Reconciled ${specs.length} Check Point group(s) on ${host}: ` +
        `${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { entries },
    }
  } catch (error) {
    await client.discard()
    await client.logout()
    return {
      success: false,
      message: `Deploy failed — session changes were discarded: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
