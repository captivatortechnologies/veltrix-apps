import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCheckpointClient,
  checkpointErrorMessage,
  isNotFoundError,
  MAX_PAGE_SIZE,
  type CheckpointClient,
} from '../../lib/checkpointApi'
import { liveTagNames } from '../lib/checkpointShared'
import { extractServiceGroupSpecs, liveMemberNames, serviceGroupKey, type LiveServiceGroup, type ServiceGroupSpec } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the service group existed before THIS deploy — set-service-group (true) vs add-service-group (false). */
  existed: boolean
  prior?: Record<string, unknown>
}

/** Build the add-service-group / set-service-group request body for a declared spec. */
export function buildServiceGroupBody(spec: ServiceGroupSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, members: spec.members }
  if (spec.comments) body.comments = spec.comments
  if (spec.color) body.color = spec.color
  if (spec.tags.length > 0) body.tags = spec.tags
  return body
}

/** Snapshot a live service-group's managed fields into a set-service-group body, for rollback. */
export function snapshotLive(live: LiveServiceGroup): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name, members: liveMemberNames(live.members) }
  if (live.comments) body.comments = live.comments
  if (live.color) body.color = live.color
  const tags = liveTagNames(live.tags)
  if (tags.length > 0) body.tags = tags
  return body
}

/** Page through show-service-groups (max 500/page) and return every service group in the domain. */
export async function listAllServiceGroups(client: CheckpointClient): Promise<LiveServiceGroup[]> {
  const groups: LiveServiceGroup[] = []
  let offset = 0
  for (;;) {
    const res = await client.call<{ objects?: LiveServiceGroup[]; total?: number }>('show-service-groups', {
      limit: MAX_PAGE_SIZE,
      offset,
      'details-level': 'standard',
    })
    if (!res.ok) throw new Error(`show-service-groups failed: ${checkpointErrorMessage(res)}`)
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
 * Deploy Check Point service groups via the Management API. Identity is the
 * group `name`: list the management database (show-service-groups), match on
 * the name, and add-service-group (create) / set-service-group (update,
 * members sent in full) each declared group. Groups THIS app created
 * previously but no longer declares are removed (delete-service-group). The
 * whole reconciliation runs inside ONE session: publish on success, discard
 * the whole session on any error.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  const specs = extractServiceGroupSpecs(ctx.canvas).filter((s) => s.name)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await listAllServiceGroups(client)
    const liveByName = new Map(live.filter((g) => g.name).map((g) => [serviceGroupKey(g.name as string), g]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(serviceGroupKey(spec.name)) ?? null
      const body = buildServiceGroupBody(spec)

      if (match) {
        const res = await client.call('set-service-group', body)
        if (!res.ok) throw new Error(`set-service-group "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const res = await client.call('add-service-group', body)
        if (!res.ok) throw new Error(`add-service-group "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => serviceGroupKey(s.name)))
    for (const p of prior) {
      if (p.existed || declaredNames.has(serviceGroupKey(p.name))) continue
      const res = await client.call('delete-service-group', { name: p.name })
      if (!res.ok && !isNotFoundError(res)) {
        throw new Error(`delete-service-group "${p.name}" failed: ${checkpointErrorMessage(res)}`)
      }
      deleted++
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message:
        `Reconciled ${specs.length} Check Point service group(s) on ${host}: ` +
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
