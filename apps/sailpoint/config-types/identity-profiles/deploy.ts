import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractIdentityProfileSpecs, parseJsonObject, type IdentityProfileSpec, type LiveIdentityProfile } from './validate'

const BASE = '/v3/identity-profiles'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { name: string; description: string; ownerId: string; priority: number }
}

export function createBody(spec: IdentityProfileSpec, attributeConfig: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    priority: spec.priority,
    authoritativeSource: { type: 'SOURCE', id: spec.authoritativeSourceId },
  }
  if (spec.ownerId) body.owner = { type: 'IDENTITY', id: spec.ownerId }
  if (Object.keys(attributeConfig).length > 0) body.identityAttributeConfig = attributeConfig
  return body
}

/** JSON-Patch ops — the authoritative source is immutable and never patched. */
export function patchOps(spec: IdentityProfileSpec, attributeConfig: Record<string, unknown>): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [
    { op: 'replace', path: '/name', value: spec.name },
    { op: 'replace', path: '/description', value: spec.description },
    { op: 'replace', path: '/priority', value: spec.priority },
    { op: 'replace', path: '/owner', value: { type: 'IDENTITY', id: spec.ownerId } },
  ]
  if (Object.keys(attributeConfig).length > 0) {
    ops.push({ op: 'replace', path: '/identityAttributeConfig', value: attributeConfig })
  }
  return ops
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

  const specs = extractIdentityProfileSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveIdentityProfile>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list identity profiles: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveIdentityProfile>()
  const liveById = new Map<string, LiveIdentityProfile>()
  for (const p of listed.items) {
    if (p.name) liveByName.set(p.name.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const parsed = parseJsonObject(spec.attributeConfigRaw)
    if (!parsed.ok) {
      failures.push(`${spec.name}: ${parsed.error}`)
      continue
    }
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.patch(`${BASE}/${live.id}`, patchOps(spec, parsed.value))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: { name: live.name ?? '', description: (live.description ?? '') as string, ownerId: live.owner?.id ?? '', priority: live.priority ?? 0 } })
    } else {
      const resp = await client.post(BASE, createBody(spec, parsed.value))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveIdentityProfile>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete identity profiles THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some identity profiles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} identity profile(s)`, rollbackData: { entries } }
}
