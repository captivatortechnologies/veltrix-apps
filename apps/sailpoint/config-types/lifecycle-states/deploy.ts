import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { LiveIdentityProfile } from '../identity-profiles/validate'
import {
  extractLifecycleStateSpecs,
  parseJsonArray,
  type LifecycleStateSpec,
  type LiveLifecycleState,
} from './validate'

const PROFILES = '/v3/identity-profiles'
const childPath = (profileId: string): string => `${PROFILES}/${profileId}/lifecycle-states`

export interface RollbackEntry {
  itemId?: string
  profileName: string
  profileId: string
  technicalName: string
  existed: boolean
  stateId?: string
  prior?: { name: string; description: string; enabled: boolean; accessProfileIds: string[]; accountActions: Array<Record<string, unknown>>; identityState: string }
}

function createBody(spec: LifecycleStateSpec, accountActions: unknown[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    technicalName: spec.technicalName,
    enabled: spec.enabled,
    description: spec.description,
    accessProfileIds: spec.accessProfileIds,
    accountActions,
  }
  if (spec.identityState) body.identityState = spec.identityState
  return body
}

function patchOps(spec: LifecycleStateSpec, accountActions: unknown[]): Array<Record<string, unknown>> {
  return [
    { op: 'replace', path: '/name', value: spec.name },
    { op: 'replace', path: '/description', value: spec.description },
    { op: 'replace', path: '/enabled', value: spec.enabled },
    { op: 'replace', path: '/accessProfileIds', value: spec.accessProfileIds },
    { op: 'replace', path: '/accountActions', value: accountActions },
  ]
}

function snapshot(live: LiveLifecycleState): RollbackEntry['prior'] {
  return {
    name: live.name ?? '',
    description: (live.description ?? '') as string,
    enabled: live.enabled ?? false,
    accessProfileIds: live.accessProfileIds ?? [],
    accountActions: live.accountActions ?? [],
    identityState: (live.identityState ?? '') as string,
  }
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
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const specs = extractLifecycleStateSpecs(ctx.canvas).filter((s) => s.name && s.profileName && s.technicalName)

  const profilesRes = await client.getAll<LiveIdentityProfile>(PROFILES)
  if (!profilesRes.ok) return { success: false, message: `Failed to list identity profiles: ${iscErrorMessage(profilesRes.lastError!)}` }
  const profileByName = new Map(profilesRes.items.filter((p) => p.name && p.id).map((p) => [p.name!.toLowerCase(), p]))

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  // Group declared states by parent profile so each parent is listed once.
  const byProfile = new Map<string, LifecycleStateSpec[]>()
  for (const spec of specs) {
    const key = spec.profileName.toLowerCase()
    const list = byProfile.get(key) ?? []
    list.push(spec)
    byProfile.set(key, list)
  }

  for (const [profileKey, group] of byProfile) {
    const profile = profileByName.get(profileKey)
    if (!profile?.id) {
      for (const s of group) failures.push(`${s.technicalName}: identity profile "${s.profileName}" not found`)
      continue
    }
    const listed = await client.getAll<LiveLifecycleState>(childPath(profile.id))
    if (!listed.ok) {
      failures.push(`profile "${group[0].profileName}": failed to list lifecycle states: ${iscErrorMessage(listed.lastError!)}`)
      continue
    }
    const liveByTech = new Map(listed.items.filter((s) => s.technicalName).map((s) => [s.technicalName!.toLowerCase(), s]))

    for (const spec of group) {
      const parsed = parseJsonArray(spec.accountActionsRaw)
      if (!parsed.ok) {
        failures.push(`${spec.technicalName}: ${parsed.error}`)
        continue
      }
      const live = liveByTech.get(spec.technicalName.toLowerCase()) ?? null
      if (live?.id) {
        const resp = await client.patch(`${childPath(profile.id)}/${live.id}`, patchOps(spec, parsed.value))
        if (!resp.ok) {
          failures.push(`${spec.technicalName}: ${iscErrorMessage(resp)}`)
          continue
        }
        entries.push({ itemId: spec.itemId, profileName: spec.profileName, profileId: profile.id, technicalName: spec.technicalName, existed: true, stateId: live.id, prior: snapshot(live) })
      } else {
        const resp = await client.post(childPath(profile.id), createBody(spec, parsed.value))
        if (!resp.ok) {
          failures.push(`${spec.technicalName}: ${iscErrorMessage(resp)}`)
          continue
        }
        const created = parseJson<LiveLifecycleState>(resp.body)
        entries.push({ itemId: spec.itemId, profileName: spec.profileName, profileId: profile.id, technicalName: spec.technicalName, existed: false, stateId: created?.id })
      }
    }
  }

  // Reconcile: delete lifecycle states THIS app created but no longer declares.
  const declared = new Set(specs.map((s) => `${s.profileName.toLowerCase()}::${s.technicalName.toLowerCase()}`))
  const keptIds = new Set(entries.map((e) => e.stateId).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.stateId && !keptIds.has(p.stateId) && !declared.has(`${p.profileName.toLowerCase()}::${p.technicalName.toLowerCase()}`)) {
      const resp = await client.delete(`${childPath(p.profileId)}/${p.stateId}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.technicalName}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some lifecycle states failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} lifecycle state(s)`, rollbackData: { entries } }
}
