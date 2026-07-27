import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractGroupSettingSpecs, parseValues, type GroupSettingSpec, type LiveGroupSetting } from './validate'

const BASE = '/groupSettings'

export interface RollbackEntry {
  itemId?: string
  /** The templateId — the logical identity. */
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

export function buildCreateBody(spec: GroupSettingSpec): Record<string, unknown> {
  return { templateId: spec.templateId, values: parseValues(spec.values) ?? [] }
}

export function buildPatchBody(spec: GroupSettingSpec): Record<string, unknown> {
  return { values: parseValues(spec.values) ?? [] }
}

function snapshotLive(live: LiveGroupSetting): Record<string, unknown> {
  return { values: live.values ?? [] }
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
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractGroupSettingSpecs(ctx.canvas).filter((s) => s.templateId)

  const listed = await client.getAll<LiveGroupSetting>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list group settings: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByTemplate = new Map<string, LiveGroupSetting>()
  for (const s of listed.items) {
    if (s.templateId) liveByTemplate.set(s.templateId.toLowerCase(), s)
  }

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const live = liveByTemplate.get(spec.templateId) ?? null

    if (live?.id) {
      const resp = await client.patch(`${BASE}/${live.id}`, buildPatchBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.templateId}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.templateId, existed: true, id: live.id, prior: snapshotLive(live) })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.templateId}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveGroupSetting>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.templateId, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete settings THIS app created previously but no longer declares.
  const declared = new Set(specs.map((s) => s.templateId))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declared.has(p.name)) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some group settings failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} group setting(s)`,
    rollbackData: { entries },
  }
}
