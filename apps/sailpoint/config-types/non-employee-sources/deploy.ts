import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractNonEmployeeSourceSpecs, type LiveNonEmployeeSource, type NonEmployeeSourceSpec } from './validate'

const BASE = '/beta/non-employee-sources'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; description: string; managementWorkgroup: string }
}

function idRefs(ids: string[]): Array<{ id: string }> {
  return ids.map((id) => ({ id }))
}

export function createBody(spec: NonEmployeeSourceSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    owner: { id: spec.ownerId },
    approvers: idRefs(spec.approvers),
    accountManagers: idRefs(spec.accountManagers),
  }
  if (spec.managementWorkgroup) body.managementWorkgroup = spec.managementWorkgroup
  return body
}

export function patchOps(spec: NonEmployeeSourceSpec): Array<Record<string, unknown>> {
  return [
    { op: 'replace', path: '/name', value: spec.name },
    { op: 'replace', path: '/description', value: spec.description },
    { op: 'replace', path: '/managementWorkgroup', value: spec.managementWorkgroup },
    { op: 'replace', path: '/approvers', value: idRefs(spec.approvers) },
    { op: 'replace', path: '/accountManagers', value: idRefs(spec.accountManagers) },
  ]
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

  const specs = extractNonEmployeeSourceSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveNonEmployeeSource>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list non-employee sources: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveNonEmployeeSource>()
  const liveById = new Map<string, LiveNonEmployeeSource>()
  for (const s of listed.items) {
    if (s.name) liveByName.set(s.name.toLowerCase(), s)
    if (s.id) liveById.set(s.id, s)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.patch(`${BASE}/${live.id}`, patchOps(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: { name: live.name ?? '', description: (live.description ?? '') as string, managementWorkgroup: (live.managementWorkgroup ?? '') as string } })
    } else {
      const resp = await client.post(BASE, createBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveNonEmployeeSource>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete non-employee sources THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some non-employee sources failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} non-employee source(s)`, rollbackData: { entries } }
}
