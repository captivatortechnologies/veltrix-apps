import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractAccessPackageSpecs, type AccessPackageSpec, type LiveAccessPackage } from './validate'

const BASE = '/identityGovernance/entitlementManagement/accessPackages'
const SELECT = '?$select=id,displayName,description,isHidden'
const CATALOGS = '/identityGovernance/entitlementManagement/catalogs?$select=id,displayName'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

interface LiveCatalog {
  id?: string
  displayName?: string
}

export function buildPatchBody(spec: AccessPackageSpec): Record<string, unknown> {
  return { displayName: spec.name, description: spec.description || '', isHidden: spec.isHidden }
}

export function buildCreateBody(spec: AccessPackageSpec, catalogId: string): Record<string, unknown> {
  return { ...buildPatchBody(spec), catalog: { id: catalogId } }
}

function snapshotLive(live: LiveAccessPackage): Record<string, unknown> {
  return { displayName: live.displayName, description: live.description ?? '', isHidden: live.isHidden ?? false }
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

  const specs = extractAccessPackageSpecs(ctx.canvas).filter((s) => s.name && s.catalogName)

  const catalogsRes = await client.getAll<LiveCatalog>(CATALOGS)
  if (!catalogsRes.ok) {
    return { success: false, message: `Failed to list catalogs: ${graphErrorMessage(catalogsRes.lastError!)}` }
  }
  const catalogByName = new Map<string, string>()
  for (const c of catalogsRes.items) {
    if (c.displayName && c.id) catalogByName.set(c.displayName.toLowerCase(), c.id)
  }

  const listed = await client.getAll<LiveAccessPackage>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list access packages: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveAccessPackage>()
  const liveById = new Map<string, LiveAccessPackage>()
  for (const p of listed.items) {
    if (p.displayName) liveByName.set(p.displayName.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const catalogId = catalogByName.get(spec.catalogName.toLowerCase())
    if (!catalogId) {
      failures.push(`${spec.name}: catalog "${spec.catalogName}" not found`)
      continue
    }
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildPatchBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec, catalogId))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAccessPackage>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some access packages failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} access package(s)`, rollbackData: { entries } }
}
