import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/fortimanager'
import { finishWorkspace } from '../firewall-addresses/deploy'
import { extractShapingProfileSpecs, parseJsonField, type ShapingProfileSpec, type LiveShapingProfile } from './validate'

export interface RollbackEntry {
  itemId?: string
  /** profile-name is the mkey — the identity. */
  name: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** The ADOM-scoped shaping-profile object path. */
export function shapingProfileUrl(adom: string): string {
  return `/pm/config/adom/${adom}/obj/firewall/shaping-profile`
}

export function buildShapingProfileBody(spec: ShapingProfileSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { 'profile-name': spec.profileName, type: spec.type }
  if (spec.defaultClassId !== undefined) body['default-class-id'] = spec.defaultClassId
  if (spec.comment) body.comment = spec.comment
  const parsed = parseJsonField(spec.shapingEntries)
  if (parsed.ok && Array.isArray(parsed.value)) body['shaping-entries'] = parsed.value
  return body
}

export function snapshotLive(live: LiveShapingProfile): Record<string, unknown> {
  const body: Record<string, unknown> = { 'profile-name': live['profile-name'] }
  for (const k of ['type', 'default-class-id', 'comment', 'shaping-entries'] as const) {
    if (live[k] !== undefined) body[k] = live[k]
  }
  return body
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
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildFmgClient(cred, settings)
  const url = shapingProfileUrl(settings.adom)
  const specs = extractShapingProfileSpecs(ctx.canvas).filter((s) => s.profileName)
  const failures: string[] = []
  const entries: RollbackEntry[] = []

  if (settings.workspaceMode) {
    const lock = await client.lock(settings.adom)
    if (!lock.ok) {
      await client.logout()
      return { success: false, message: `Failed to lock ADOM "${settings.adom}": ${fmgErrorMessage(lock)}` }
    }
  }

  try {
    const listed = await client.get(url)
    if (!listed.ok) {
      failures.push(`list: ${fmgErrorMessage(listed)}`)
    } else {
      const live = Array.isArray(listed.data) ? (listed.data as LiveShapingProfile[]) : []
      const liveByName = new Map<string, LiveShapingProfile>()
      for (const p of live) if (p['profile-name']) liveByName.set(p['profile-name']!.toLowerCase(), p)

      const prior = await loadPriorEntries(ctx)

      for (const spec of specs) {
        const liveMatch = liveByName.get(spec.profileName.toLowerCase()) ?? null
        const resp = await client.set(url, buildShapingProfileBody(spec))
        if (!resp.ok) {
          failures.push(`${spec.profileName}: ${fmgErrorMessage(resp)}`)
          continue
        }
        entries.push({ itemId: spec.itemId, name: spec.profileName, existed: !!liveMatch, prior: liveMatch ? snapshotLive(liveMatch) : undefined })
      }

      // Reconcile: delete profiles THIS app created but no longer declares (by profile-name).
      const declaredNames = new Set(specs.map((s) => s.profileName.toLowerCase()))
      for (const p of prior) {
        if (!p.existed && !declaredNames.has(p.name.toLowerCase())) {
          const resp = await client.delete(url, ['profile-name', '==', p.name])
          if (!resp.ok) failures.push(`delete ${p.name}: ${fmgErrorMessage(resp)}`)
        }
      }
    }

    if (settings.workspaceMode) await finishWorkspace(client, settings.adom, failures)
  } finally {
    await client.logout()
  }

  if (failures.length) {
    return { success: false, message: `Some shaping profiles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} firewall shaping profile(s)`, rollbackData: { entries } }
}
