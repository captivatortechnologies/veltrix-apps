import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCheckpointClient,
  checkpointErrorMessage,
  isNotFoundError,
  MAX_PAGE_SIZE,
  type CheckpointClient,
} from '../../lib/checkpointApi'
import { extractTagSpecs, tagKey, type LiveTag, type TagSpec } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the tag existed before THIS deploy — set-tag (true) vs add-tag (false). */
  existed: boolean
  prior?: Record<string, unknown>
}

/** Build the add-tag / set-tag request body for a declared spec. */
export function buildTagBody(spec: TagSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name }
  if (spec.comments) body.comments = spec.comments
  if (spec.color) body.color = spec.color
  return body
}

/** Snapshot a live tag's managed fields into a set-tag-compatible body, for rollback. */
export function snapshotLive(live: LiveTag): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  if (live.comments) body.comments = live.comments
  if (live.color) body.color = live.color
  return body
}

/** Page through show-tags (max 500/page) and return every tag in the domain. */
export async function listAllTags(client: CheckpointClient): Promise<LiveTag[]> {
  const tags: LiveTag[] = []
  let offset = 0
  for (;;) {
    const res = await client.call<{ objects?: LiveTag[]; total?: number }>('show-tags', {
      limit: MAX_PAGE_SIZE,
      offset,
      'details-level': 'standard',
    })
    if (!res.ok) throw new Error(`show-tags failed: ${checkpointErrorMessage(res)}`)
    const objects = res.data?.objects ?? []
    tags.push(...objects)
    const total = res.data?.total ?? objects.length
    offset += objects.length
    if (objects.length === 0 || offset >= total) break
  }
  return tags
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
 * Deploy Check Point tags via the Management API. Identity is the tag
 * `name`: list the management database (show-tags), match on the name, and
 * add-tag (create) / set-tag (update) each declared tag. Tags THIS app
 * created previously but no longer declares are removed (delete-tag). The
 * whole reconciliation runs inside ONE session: publish on success, discard
 * the whole session on any error.
 *
 * Note: most other config types in this app can implicitly create a tag by
 * naming it in their own `tags` field — Check Point auto-creates a
 * referenced tag that doesn't yet exist. This config type exists for
 * declaring a tag's OWN color/comments explicitly, or for a tag no other
 * object references yet.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  const specs = extractTagSpecs(ctx.canvas).filter((s) => s.name)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await listAllTags(client)
    const liveByName = new Map(live.filter((t) => t.name).map((t) => [tagKey(t.name as string), t]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(tagKey(spec.name)) ?? null
      const body = buildTagBody(spec)

      if (match) {
        const res = await client.call('set-tag', body)
        if (!res.ok) throw new Error(`set-tag "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const res = await client.call('add-tag', body)
        if (!res.ok) throw new Error(`add-tag "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => tagKey(s.name)))
    for (const p of prior) {
      if (p.existed || declaredNames.has(tagKey(p.name))) continue
      const res = await client.call('delete-tag', { name: p.name })
      if (!res.ok && !isNotFoundError(res)) {
        throw new Error(`delete-tag "${p.name}" failed: ${checkpointErrorMessage(res)}`)
      }
      deleted++
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message:
        `Reconciled ${specs.length} Check Point tag(s) on ${host}: ` +
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
