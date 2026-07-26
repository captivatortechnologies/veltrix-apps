import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  parseJson,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/prismacloud'
import { extractAccountGroupSpecs, type AccountGroupSpec, type LiveAccountGroup } from './validate'

const BASE = '/cloud/group'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; description: string; accountIds: string[] }
}

export function groupBody(spec: AccountGroupSpec): Record<string, unknown> {
  return { name: spec.name, description: spec.description, accountIds: spec.accountIds }
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
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildPcClient(cred, settings)

  const specs = extractAccountGroupSpecs(ctx.canvas).filter((s) => s.name)

  const listRes = await client.get(BASE)
  if (!listRes.ok) return { success: false, message: `Failed to list account groups: ${pcErrorMessage(listRes)}` }
  const live = parseJson<LiveAccountGroup[]>(listRes.body) ?? []
  const liveByName = new Map<string, LiveAccountGroup>()
  const liveById = new Map<string, LiveAccountGroup>()
  for (const g of live) {
    if (g.name) liveByName.set(g.name.toLowerCase(), g)
    if (g.id) liveById.set(g.id, g)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const match = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (match?.id) {
      if (match.autoCreated) {
        failures.push(`${spec.name}: an auto-created account group with this name exists and will not be modified`)
        continue
      }
      const resp = await client.put(`${BASE}/${match.id}`, groupBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: match.id, prior: { name: match.name ?? '', description: (match.description ?? '') as string, accountIds: match.accountIds ?? [] } })
    } else {
      const resp = await client.post(BASE, groupBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAccountGroup>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete groups THIS app created previously but no longer declares.
  // Prisma blocks deleting a group still referenced by a cloud account or alert
  // rule — such a failure is surfaced rather than silently ignored.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some account groups failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} account group(s)`, rollbackData: { entries } }
}
