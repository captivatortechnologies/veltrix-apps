import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractNpaObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { extractPolicyGroupSpecs, isBuiltInGroup, type LivePolicyGroup, type PolicyGroupSpec } from './validate'

const BASE = '/policy/npa/policygroups'
const LIST_KEY = 'policy_groups'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string }
}

export function policyGroupBody(spec: PolicyGroupSpec): Record<string, unknown> {
  return { group_name: spec.name }
}

function liveGroupId(l: LivePolicyGroup): string | undefined {
  return l.id === undefined || l.id === null ? undefined : String(l.id)
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

  const specs = extractPolicyGroupSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAllNpa<LivePolicyGroup>(BASE, LIST_KEY)
  if (!listed.ok) return { success: false, message: `Failed to list NPA policy groups: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LivePolicyGroup>()
  const liveById = new Map<string, LivePolicyGroup>()
  for (const g of listed.items) {
    if (g.group_name) liveByName.set(g.group_name.toLowerCase(), g)
    const id = liveGroupId(g)
    if (id) liveById.set(id, g)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveGroupId(live) : undefined

    if (liveId) {
      // Built-in groups (can_be_edited_deleted=false) are preserved as-is; a
      // rename would be rejected, so record the match and skip the write.
      if (!isBuiltInGroup(live!) && (live!.group_name ?? '') !== spec.name) {
        const resp = await client.put(`${BASE}/${liveId}`, policyGroupBody(spec))
        if (!resp.ok) {
          failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: { name: live!.group_name ?? '' } })
    } else {
      const resp = await client.post(BASE, policyGroupBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractNpaObject<LivePolicyGroup>(resp.body)
      const newId = created ? liveGroupId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete policy groups THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some NPA policy groups failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} NPA policy group(s)`, rollbackData: { entries } }
}
