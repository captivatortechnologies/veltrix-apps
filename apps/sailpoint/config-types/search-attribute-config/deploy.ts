import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractSearchAttributeSpecs, type LiveSearchAttribute, type SearchAttributeSpec } from './validate'

const BASE = '/v3/accounts/search-attribute-config'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  prior?: { displayName: string; applicationAttributes: Record<string, string> }
}

export function createBody(spec: SearchAttributeSpec): Record<string, unknown> {
  return { name: spec.name, displayName: spec.displayName, applicationAttributes: spec.applicationAttributes }
}

export function patchOps(spec: SearchAttributeSpec): Array<Record<string, unknown>> {
  return [
    { op: 'replace', path: '/displayName', value: spec.displayName },
    { op: 'replace', path: '/applicationAttributes', value: spec.applicationAttributes },
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

  const specs = extractSearchAttributeSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveSearchAttribute>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list search attribute config: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveSearchAttribute>()
  for (const a of listed.items) {
    if (a.name) liveByName.set(a.name.toLowerCase(), a)
  }

  const prior = await loadPriorEntries(ctx)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase()) ?? null
    if (live) {
      const resp = await client.patch(`${BASE}/${encodeURIComponent(spec.name)}`, patchOps(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, prior: { displayName: live.displayName ?? '', applicationAttributes: live.applicationAttributes ?? {} } })
    } else {
      const resp = await client.post(BASE, createBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false })
    }
  }

  // Reconcile: delete search attributes THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptNames = new Set(entries.map((e) => e.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && !keptNames.has(p.name.toLowerCase()) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${encodeURIComponent(p.name)}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some search attributes failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} search attribute(s)`, rollbackData: { entries } }
}
