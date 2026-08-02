import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCheckpointClient,
  checkpointErrorMessage,
  isNotFoundError,
  MAX_PAGE_SIZE,
  type CheckpointClient,
} from '../../lib/checkpointApi'
import { liveTagNames } from '../lib/checkpointShared'
import { extractNetworkSpecs, networkKey, parseIpv4Cidr, parseIpv6Cidr, type NetworkSpec, type LiveNetwork } from './validate'

export interface RollbackEntry {
  itemId?: string
  /** name is the identity Check Point network objects are matched on. */
  name: string
  /** Whether the network existed before THIS deploy — set-network (true) vs add-network (false). */
  existed: boolean
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/** Build the add-network / set-network request body for a declared spec. */
export function buildNetworkBody(spec: NetworkSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name }
  const v4 = spec.subnetCidr ? parseIpv4Cidr(spec.subnetCidr) : null
  if (v4) {
    body.subnet4 = v4.subnet4
    body['mask-length4'] = v4.maskLength4
  }
  const v6 = spec.subnet6Cidr ? parseIpv6Cidr(spec.subnet6Cidr) : null
  if (v6) {
    body.subnet6 = v6.subnet6
    body['mask-length6'] = v6.maskLength6
  }
  if (spec.comments) body.comments = spec.comments
  if (spec.color) body.color = spec.color
  if (spec.tags.length > 0) body.tags = spec.tags
  return body
}

/** Snapshot a live network's managed fields into a set-network-compatible body, for rollback. */
export function snapshotLive(live: LiveNetwork): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  if (live.subnet4) body.subnet4 = live.subnet4
  if (live['mask-length4'] != null) body['mask-length4'] = live['mask-length4']
  if (live.subnet6) body.subnet6 = live.subnet6
  if (live['mask-length6'] != null) body['mask-length6'] = live['mask-length6']
  if (live.comments) body.comments = live.comments
  if (live.color) body.color = live.color
  const tags = liveTagNames(live.tags)
  if (tags.length > 0) body.tags = tags
  return body
}

/** Page through show-networks (max 500/page) and return every network in the domain. */
export async function listAllNetworks(client: CheckpointClient): Promise<LiveNetwork[]> {
  const networks: LiveNetwork[] = []
  let offset = 0
  for (;;) {
    const res = await client.call<{ objects?: LiveNetwork[]; total?: number }>('show-networks', {
      limit: MAX_PAGE_SIZE,
      offset,
      'details-level': 'standard',
    })
    if (!res.ok) throw new Error(`show-networks failed: ${checkpointErrorMessage(res)}`)
    const objects = res.data?.objects ?? []
    networks.push(...objects)
    const total = res.data?.total ?? objects.length
    offset += objects.length
    if (objects.length === 0 || offset >= total) break
  }
  return networks
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
 * Deploy Check Point network (subnet) objects via the Management API.
 *
 * Identity is the network `name`: list the management database
 * (show-networks), match on the name, and add-network (create) / set-network
 * (update) each declared network. Networks THIS app created previously but no
 * longer declares are removed (delete-network). The whole reconciliation
 * runs inside ONE session: on success, publish commits every change
 * together; on ANY error, discard throws the whole session's changes away
 * before logout.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  const specs = extractNetworkSpecs(ctx.canvas).filter((s) => s.name)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await listAllNetworks(client)
    const liveByName = new Map(live.filter((n) => n.name).map((n) => [networkKey(n.name as string), n]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(networkKey(spec.name)) ?? null
      const body = buildNetworkBody(spec)

      if (match) {
        const res = await client.call('set-network', body)
        if (!res.ok) throw new Error(`set-network "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const res = await client.call('add-network', body)
        if (!res.ok) throw new Error(`add-network "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => networkKey(s.name)))
    for (const p of prior) {
      if (p.existed || declaredNames.has(networkKey(p.name))) continue
      const res = await client.call('delete-network', { name: p.name })
      if (!res.ok && !isNotFoundError(res)) {
        throw new Error(`delete-network "${p.name}" failed: ${checkpointErrorMessage(res)}`)
      }
      deleted++
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message:
        `Reconciled ${specs.length} Check Point network object(s) on ${host}: ` +
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
