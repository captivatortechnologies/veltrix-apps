import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractNpaObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { extractUpgradeProfileSpecs, liveUpgradeProfileId, type LiveUpgradeProfile, type UpgradeProfileSpec } from './validate'

const BASE = '/infrastructure/publisherupgradeprofiles'
const LIST_KEY = 'upgrade_profiles'

export interface UpgradeProfileSnapshot {
  name: string
  docker_tag: string
  release_type: string
  enabled: boolean
  frequency: string
  timezone: string
  timezone_id?: number
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: UpgradeProfileSnapshot
}

export function upgradeProfileBody(spec: UpgradeProfileSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    docker_tag: spec.dockerTag,
    release_type: spec.releaseType,
    enabled: spec.enabled,
    frequency: spec.frequency,
    timezone: spec.timezone,
  }
  if (spec.timezoneId > 0) body.timezone_id = spec.timezoneId
  return body
}

function snapshotLive(live: LiveUpgradeProfile): UpgradeProfileSnapshot {
  const snap: UpgradeProfileSnapshot = {
    name: live.name ?? '',
    docker_tag: live.docker_tag ?? '',
    release_type: live.release_type ?? 'Latest',
    enabled: live.enabled !== false,
    frequency: live.frequency ?? '',
    timezone: live.timezone ?? '',
  }
  if (typeof live.timezone_id === 'number') snap.timezone_id = live.timezone_id
  return snap
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

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractUpgradeProfileSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAllNpa<LiveUpgradeProfile>(BASE, LIST_KEY)
  if (!listed.ok) return { success: false, message: `Failed to list publisher upgrade profiles: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveUpgradeProfile>()
  const liveById = new Map<string, LiveUpgradeProfile>()
  for (const p of listed.items) {
    if (p.name) liveByName.set(p.name.toLowerCase(), p)
    const id = liveUpgradeProfileId(p)
    if (id) liveById.set(id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveUpgradeProfileId(live) : undefined

    if (liveId) {
      const resp = await client.put(`${BASE}/${liveId}`, upgradeProfileBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, upgradeProfileBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractNpaObject<LiveUpgradeProfile>(resp.body)
      const newId = created ? liveUpgradeProfileId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete upgrade profiles THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some publisher upgrade profiles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} publisher upgrade profile(s)`, rollbackData: { entries } }
}
