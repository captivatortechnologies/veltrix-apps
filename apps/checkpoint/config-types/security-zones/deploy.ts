import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCheckpointClient,
  checkpointErrorMessage,
  isNotFoundError,
  MAX_PAGE_SIZE,
  type CheckpointClient,
} from '../../lib/checkpointApi'
import { liveTagNames } from '../lib/checkpointShared'
import { extractSecurityZoneSpecs, securityZoneKey, type LiveSecurityZone, type SecurityZoneSpec } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the zone existed before THIS deploy — set-security-zone (true) vs add-security-zone (false). */
  existed: boolean
  prior?: Record<string, unknown>
}

/** Build the add-security-zone / set-security-zone request body for a declared spec. */
export function buildSecurityZoneBody(spec: SecurityZoneSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name }
  if (spec.comments) body.comments = spec.comments
  if (spec.color) body.color = spec.color
  if (spec.tags.length > 0) body.tags = spec.tags
  return body
}

/** Snapshot a live security zone's managed fields into a set-security-zone body, for rollback. */
export function snapshotLive(live: LiveSecurityZone): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  if (live.comments) body.comments = live.comments
  if (live.color) body.color = live.color
  const tags = liveTagNames(live.tags)
  if (tags.length > 0) body.tags = tags
  return body
}

/** Page through show-security-zones (max 500/page) and return every zone in the domain. */
export async function listAllSecurityZones(client: CheckpointClient): Promise<LiveSecurityZone[]> {
  const zones: LiveSecurityZone[] = []
  let offset = 0
  for (;;) {
    const res = await client.call<{ objects?: LiveSecurityZone[]; total?: number }>('show-security-zones', {
      limit: MAX_PAGE_SIZE,
      offset,
      'details-level': 'standard',
    })
    if (!res.ok) throw new Error(`show-security-zones failed: ${checkpointErrorMessage(res)}`)
    const objects = res.data?.objects ?? []
    zones.push(...objects)
    const total = res.data?.total ?? objects.length
    offset += objects.length
    if (objects.length === 0 || offset >= total) break
  }
  return zones
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
 * Deploy Check Point security zones via the Management API. Identity is the
 * zone `name`: list the management database (show-security-zones), match on
 * the name, and add-security-zone (create) / set-security-zone (update) each
 * declared zone. Zones THIS app created previously but no longer declares
 * are removed (delete-security-zone). The whole reconciliation runs inside
 * ONE session: publish on success, discard the whole session on any error.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  const specs = extractSecurityZoneSpecs(ctx.canvas).filter((s) => s.name)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await listAllSecurityZones(client)
    const liveByName = new Map(live.filter((z) => z.name).map((z) => [securityZoneKey(z.name as string), z]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(securityZoneKey(spec.name)) ?? null
      const body = buildSecurityZoneBody(spec)

      if (match) {
        const res = await client.call('set-security-zone', body)
        if (!res.ok) throw new Error(`set-security-zone "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const res = await client.call('add-security-zone', body)
        if (!res.ok) throw new Error(`add-security-zone "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => securityZoneKey(s.name)))
    for (const p of prior) {
      if (p.existed || declaredNames.has(securityZoneKey(p.name))) continue
      const res = await client.call('delete-security-zone', { name: p.name })
      if (!res.ok && !isNotFoundError(res)) {
        throw new Error(`delete-security-zone "${p.name}" failed: ${checkpointErrorMessage(res)}`)
      }
      deleted++
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message:
        `Reconciled ${specs.length} Check Point security zone(s) on ${host}: ` +
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
