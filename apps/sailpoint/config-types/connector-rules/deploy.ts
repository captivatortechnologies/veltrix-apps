import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import { extractConnectorRuleSpecs, parseJsonObject, type ConnectorRuleSpec, type LiveConnectorRule } from './validate'

const BASE = '/beta/connector-rules'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

export function buildBody(spec: ConnectorRuleSpec, signature: Record<string, unknown>, attributes: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    type: spec.type,
    description: spec.description,
    sourceCode: { version: spec.version, script: spec.script },
  }
  if (Object.keys(signature).length > 0) body.signature = signature
  if (Object.keys(attributes).length > 0) body.attributes = attributes
  return body
}

function snapshot(live: LiveConnectorRule): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: live.name,
    type: live.type,
    description: live.description ?? '',
    sourceCode: live.sourceCode ?? { version: '1.0', script: '' },
  }
  if (live.signature) body.signature = live.signature
  if (live.attributes) body.attributes = live.attributes
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
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const specs = extractConnectorRuleSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveConnectorRule>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list connector rules: ${iscErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveConnectorRule>()
  const liveById = new Map<string, LiveConnectorRule>()
  for (const r of listed.items) {
    if (r.name) liveByName.set(r.name.toLowerCase(), r)
    if (r.id) liveById.set(r.id, r)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const sig = parseJsonObject(spec.signatureRaw)
    const attrs = parseJsonObject(spec.attributesRaw)
    if (!sig.ok || !attrs.ok) {
      failures.push(`${spec.name}: ${!sig.ok ? sig.error : (attrs as { error: string }).error}`)
      continue
    }
    const body = buildBody(spec, sig.value, attrs.value)
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      if (live.type && spec.type && live.type !== spec.type) {
        failures.push(`${spec.name}: a connector rule with this name exists with type "${live.type}" — type is immutable, so rename or delete it first`)
        continue
      }
      const resp = await client.put(`${BASE}/${live.id}`, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: snapshot(live) })
    } else {
      const resp = await client.post(BASE, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveConnectorRule>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete connector rules THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some connector rules failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} connector rule(s)`, rollbackData: { entries } }
}
