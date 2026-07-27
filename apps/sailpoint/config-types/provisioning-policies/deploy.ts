import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { LiveSource } from '../sources/validate'
import {
  extractProvisioningPolicySpecs,
  parseJsonArray,
  type LiveProvisioningPolicy,
  type ProvisioningPolicySpec,
} from './validate'

const SOURCES = '/v3/sources'
const childBase = (sourceId: string): string => `${SOURCES}/${sourceId}/provisioning-policies`

export interface RollbackEntry {
  itemId?: string
  sourceName: string
  sourceId: string
  usageType: string
  existed: boolean
  prior?: Record<string, unknown>
}

function buildBody(spec: ProvisioningPolicySpec, fields: unknown[]): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    usageType: spec.usageType,
    fields,
  }
}

function snapshot(live: LiveProvisioningPolicy): Record<string, unknown> {
  return { name: live.name, description: live.description ?? '', usageType: live.usageType, fields: live.fields ?? [] }
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

  const specs = extractProvisioningPolicySpecs(ctx.canvas).filter((s) => s.name && s.sourceName)

  const sourcesRes = await client.getAll<LiveSource>(SOURCES)
  if (!sourcesRes.ok) return { success: false, message: `Failed to list sources: ${iscErrorMessage(sourcesRes.lastError!)}` }
  const sourceByName = new Map(sourcesRes.items.filter((s) => s.name && s.id).map((s) => [s.name!.toLowerCase(), s]))

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  const bySource = new Map<string, ProvisioningPolicySpec[]>()
  for (const spec of specs) {
    const key = spec.sourceName.toLowerCase()
    const list = bySource.get(key) ?? []
    list.push(spec)
    bySource.set(key, list)
  }

  for (const [sourceKey, group] of bySource) {
    const source = sourceByName.get(sourceKey)
    if (!source?.id) {
      for (const s of group) failures.push(`${s.usageType}: source "${s.sourceName}" not found`)
      continue
    }
    const listed = await client.getAll<LiveProvisioningPolicy>(childBase(source.id))
    if (!listed.ok) {
      failures.push(`source "${group[0].sourceName}": failed to list provisioning policies: ${iscErrorMessage(listed.lastError!)}`)
      continue
    }
    const liveByUsage = new Map(listed.items.filter((p) => p.usageType).map((p) => [p.usageType!, p]))

    for (const spec of group) {
      const parsed = parseJsonArray(spec.fieldsRaw)
      if (!parsed.ok) {
        failures.push(`${spec.usageType}: ${parsed.error}`)
        continue
      }
      const body = buildBody(spec, parsed.value)
      const live = liveByUsage.get(spec.usageType) ?? null
      if (live) {
        const resp = await client.put(`${childBase(source.id)}/${spec.usageType}`, body)
        if (!resp.ok) {
          failures.push(`${spec.usageType}: ${iscErrorMessage(resp)}`)
          continue
        }
        entries.push({ itemId: spec.itemId, sourceName: spec.sourceName, sourceId: source.id, usageType: spec.usageType, existed: true, prior: snapshot(live) })
      } else {
        const resp = await client.post(childBase(source.id), body)
        if (!resp.ok) {
          failures.push(`${spec.usageType}: ${iscErrorMessage(resp)}`)
          continue
        }
        entries.push({ itemId: spec.itemId, sourceName: spec.sourceName, sourceId: source.id, usageType: spec.usageType, existed: false })
      }
    }
  }

  // Reconcile: delete provisioning policies THIS app created but no longer declares.
  const declared = new Set(specs.map((s) => `${s.sourceName.toLowerCase()}::${s.usageType}`))
  const kept = new Set(entries.map((e) => `${e.sourceName.toLowerCase()}::${e.usageType}`))
  for (const p of prior) {
    const key = `${p.sourceName.toLowerCase()}::${p.usageType}`
    if (!p.existed && !kept.has(key) && !declared.has(key)) {
      const resp = await client.delete(`${childBase(p.sourceId)}/${p.usageType}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.usageType}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some provisioning policies failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} provisioning policy(ies)`, rollbackData: { entries } }
}
