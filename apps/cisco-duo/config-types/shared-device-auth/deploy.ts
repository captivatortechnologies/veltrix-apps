import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/duo'
import {
  extractSharedDeviceAuthSpecs,
  liveGroupIds,
  liveTrustedEndpointIntegrationIds,
  type SharedDeviceAuthSpec,
  type LiveSharedDeviceAuth,
} from './validate'

const BASE = '/admin/v1/desktop_authenticators/shared_device_auth'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the configuration existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** Duo shared_device_key assigned to the configuration. */
  sharedDeviceKey?: string
  /** Prior fields, captured before an update so rollback can restore them. */
  prior?: { name: string; active: boolean; groupIds: string[]; trustedEndpointIntegrationIds: string[] }
}

/** JSON body shared by create (POST) and update (PUT) — both are V5(JSON)-signed. */
export function buildSharedDeviceAuthBody(spec: SharedDeviceAuthSpec): Record<string, unknown> {
  return {
    name: spec.name,
    active: spec.active ? 1 : 0,
    group_id_list: spec.groupIds,
    trusted_endpoint_integration_id_list: spec.trustedEndpointIntegrationIds,
  }
}

/** Duo wraps even single-item responses (create/update/get-by-key) in a 1-element array. */
function firstItem(response: unknown): LiveSharedDeviceAuth | null {
  if (Array.isArray(response)) return (response[0] as LiveSharedDeviceAuth) ?? null
  return (response as LiveSharedDeviceAuth) ?? null
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
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const specs = extractSharedDeviceAuthSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAllV5<LiveSharedDeviceAuth>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list shared device authentication configurations: ${duoErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveSharedDeviceAuth>()
  const liveByKey = new Map<string, LiveSharedDeviceAuth>()
  for (const c of listed.items) {
    if (c.name) liveByName.set(c.name.toLowerCase(), c)
    if (c.shared_device_key) liveByKey.set(c.shared_device_key, c)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    // Prefer the key stored last deploy (rename-safe), else match by name.
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live =
      (priorEntry?.sharedDeviceKey ? liveByKey.get(priorEntry.sharedDeviceKey) : undefined) ??
      liveByName.get(spec.name.toLowerCase()) ??
      null

    if (live?.shared_device_key) {
      const priorState = {
        name: live.name ?? '',
        active: live.active === true,
        groupIds: liveGroupIds(live),
        trustedEndpointIntegrationIds: liveTrustedEndpointIntegrationIds(live),
      }
      const resp = await client.putV5(`${BASE}/${live.shared_device_key}`, buildSharedDeviceAuthBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${duoErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, sharedDeviceKey: live.shared_device_key, prior: priorState })
    } else {
      const resp = await client.postV5(BASE, buildSharedDeviceAuthBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${duoErrorMessage(resp)}`)
        continue
      }
      const created = firstItem(resp.response)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, sharedDeviceKey: created?.shared_device_key })
    }
  }

  // Reconcile: delete configurations THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptKeys = new Set(entries.map((e) => e.sharedDeviceKey).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.sharedDeviceKey && !keptKeys.has(p.sharedDeviceKey) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.deleteV5(`${BASE}/${p.sharedDeviceKey}`)
      if (!resp.ok) failures.push(`delete ${p.name}: ${duoErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some shared device authentication configurations failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} shared device authentication configuration(s)`, rollbackData: { entries } }
}
