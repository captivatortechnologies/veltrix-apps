import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCheckpointClient,
  checkpointErrorMessage,
  isNotFoundError,
  MAX_PAGE_SIZE,
  type CheckpointClient,
} from '../../lib/checkpointApi'
import { extractHostSpecs, hostKey, liveTagNames, type HostSpec, type LiveHost } from './validate'

export interface RollbackEntry {
  itemId?: string
  /** name is the identity Check Point host objects are matched on. */
  name: string
  /** Whether the host existed before THIS deploy — set-host (true) vs add-host (false). */
  existed: boolean
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/** Build the add-host / set-host request body for a declared spec. */
export function buildHostBody(spec: HostSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name }
  if (spec.ipv4Address) body['ipv4-address'] = spec.ipv4Address
  if (spec.ipv6Address) body['ipv6-address'] = spec.ipv6Address
  if (spec.comments) body.comments = spec.comments
  if (spec.color) body.color = spec.color
  if (spec.tags.length > 0) body.tags = spec.tags
  return body
}

/** Snapshot a live host's managed fields into a set-host-compatible body, for rollback. */
export function snapshotLive(live: LiveHost): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  if (live['ipv4-address']) body['ipv4-address'] = live['ipv4-address']
  if (live['ipv6-address']) body['ipv6-address'] = live['ipv6-address']
  if (live.comments) body.comments = live.comments
  if (live.color) body.color = live.color
  const tags = liveTagNames(live.tags)
  if (tags.length > 0) body.tags = tags
  return body
}

/** Page through show-hosts (max 500/page) and return every host in the domain. */
export async function listAllHosts(client: CheckpointClient): Promise<LiveHost[]> {
  const hosts: LiveHost[] = []
  let offset = 0
  for (;;) {
    const res = await client.call<{ objects?: LiveHost[]; total?: number }>('show-hosts', {
      limit: MAX_PAGE_SIZE,
      offset,
      'details-level': 'standard',
    })
    if (!res.ok) throw new Error(`show-hosts failed: ${checkpointErrorMessage(res)}`)
    const objects = res.data?.objects ?? []
    hosts.push(...objects)
    const total = res.data?.total ?? objects.length
    offset += objects.length
    if (objects.length === 0 || offset >= total) break
  }
  return hosts
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
 * Deploy Check Point network host objects via the Management API.
 *
 * Identity is the host `name`: list the management database (show-hosts),
 * match on the name, and add-host (create) / set-host (update) each declared
 * host. Hosts THIS app created previously but no longer declares are removed
 * (delete-host). The whole reconciliation runs inside ONE session: on
 * success, publish commits every change together; on ANY error, discard
 * throws the whole session's changes away before logout — so a failure never
 * leaves a half-applied configuration published.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  const specs = extractHostSpecs(ctx.canvas).filter((s) => s.name)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await listAllHosts(client)
    const liveByName = new Map(live.filter((h) => h.name).map((h) => [hostKey(h.name as string), h]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(hostKey(spec.name)) ?? null
      const body = buildHostBody(spec)

      if (match) {
        const res = await client.call('set-host', body)
        if (!res.ok) throw new Error(`set-host "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const res = await client.call('add-host', body)
        if (!res.ok) throw new Error(`add-host "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false })
        created++
      }
    }

    // Reconcile: delete hosts THIS app created previously but no longer declares.
    const declaredNames = new Set(specs.map((s) => hostKey(s.name)))
    for (const p of prior) {
      if (p.existed || declaredNames.has(hostKey(p.name))) continue
      const res = await client.call('delete-host', { name: p.name })
      if (!res.ok && !isNotFoundError(res)) {
        throw new Error(`delete-host "${p.name}" failed: ${checkpointErrorMessage(res)}`)
      }
      deleted++
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message:
        `Reconciled ${specs.length} Check Point host object(s) on ${host}: ` +
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
