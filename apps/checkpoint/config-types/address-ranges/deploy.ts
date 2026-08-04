import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCheckpointClient,
  checkpointErrorMessage,
  isNotFoundError,
  MAX_PAGE_SIZE,
  type CheckpointClient,
} from '../../lib/checkpointApi'
import { liveTagNames } from '../lib/checkpointShared'
import { addressRangeKey, extractAddressRangeSpecs, type AddressRangeSpec, type LiveAddressRange } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the address range existed before THIS deploy — set-address-range (true) vs add-address-range (false). */
  existed: boolean
  prior?: Record<string, unknown>
}

/** Build the add-address-range / set-address-range request body for a declared spec. */
export function buildAddressRangeBody(spec: AddressRangeSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name }
  if (spec.ipv4First) body['ipv4-address-first'] = spec.ipv4First
  if (spec.ipv4Last) body['ipv4-address-last'] = spec.ipv4Last
  if (spec.ipv6First) body['ipv6-address-first'] = spec.ipv6First
  if (spec.ipv6Last) body['ipv6-address-last'] = spec.ipv6Last
  if (spec.comments) body.comments = spec.comments
  if (spec.color) body.color = spec.color
  if (spec.tags.length > 0) body.tags = spec.tags
  return body
}

/** Snapshot a live address-range's managed fields into a set-address-range body, for rollback. */
export function snapshotLive(live: LiveAddressRange): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  if (live['ipv4-address-first']) body['ipv4-address-first'] = live['ipv4-address-first']
  if (live['ipv4-address-last']) body['ipv4-address-last'] = live['ipv4-address-last']
  if (live['ipv6-address-first']) body['ipv6-address-first'] = live['ipv6-address-first']
  if (live['ipv6-address-last']) body['ipv6-address-last'] = live['ipv6-address-last']
  if (live.comments) body.comments = live.comments
  if (live.color) body.color = live.color
  const tags = liveTagNames(live.tags)
  if (tags.length > 0) body.tags = tags
  return body
}

/** Page through show-address-ranges (max 500/page) and return every address range in the domain. */
export async function listAllAddressRanges(client: CheckpointClient): Promise<LiveAddressRange[]> {
  const ranges: LiveAddressRange[] = []
  let offset = 0
  for (;;) {
    const res = await client.call<{ objects?: LiveAddressRange[]; total?: number }>('show-address-ranges', {
      limit: MAX_PAGE_SIZE,
      offset,
      'details-level': 'standard',
    })
    if (!res.ok) throw new Error(`show-address-ranges failed: ${checkpointErrorMessage(res)}`)
    const objects = res.data?.objects ?? []
    ranges.push(...objects)
    const total = res.data?.total ?? objects.length
    offset += objects.length
    if (objects.length === 0 || offset >= total) break
  }
  return ranges
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
 * Deploy Check Point address ranges via the Management API. Identity is the
 * range `name`: list the management database (show-address-ranges), match on
 * the name, and add-address-range (create) / set-address-range (update) each
 * declared range. Ranges THIS app created previously but no longer declares
 * are removed (delete-address-range). The whole reconciliation runs inside
 * ONE session: publish on success, discard the whole session on any error.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  const specs = extractAddressRangeSpecs(ctx.canvas).filter((s) => s.name)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await listAllAddressRanges(client)
    const liveByName = new Map(live.filter((r) => r.name).map((r) => [addressRangeKey(r.name as string), r]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(addressRangeKey(spec.name)) ?? null
      const body = buildAddressRangeBody(spec)

      if (match) {
        const res = await client.call('set-address-range', body)
        if (!res.ok) throw new Error(`set-address-range "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const res = await client.call('add-address-range', body)
        if (!res.ok) throw new Error(`add-address-range "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => addressRangeKey(s.name)))
    for (const p of prior) {
      if (p.existed || declaredNames.has(addressRangeKey(p.name))) continue
      const res = await client.call('delete-address-range', { name: p.name })
      if (!res.ok && !isNotFoundError(res)) {
        throw new Error(`delete-address-range "${p.name}" failed: ${checkpointErrorMessage(res)}`)
      }
      deleted++
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message:
        `Reconciled ${specs.length} Check Point address range(s) on ${host}: ` +
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
