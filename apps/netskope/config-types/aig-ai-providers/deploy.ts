import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractNpaObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { extractAiProviderSpecs, liveAiProviderId, type AiProviderSpec, type LiveAiProvider } from './validate'

const BASE = '/aig/aiproviders'

/** Rollback snapshot — the certificate is write-only and cannot be restored. */
export interface AiProviderSnapshot {
  name: string
  schema: string
  host: string
  port: number
  protocol: string
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: AiProviderSnapshot
}

export function aiProviderBody(spec: AiProviderSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    schema: spec.schema,
    host: spec.host,
    port: spec.port,
    protocol: spec.protocol,
  }
  if (spec.certificate) body.certificate = spec.certificate
  return body
}

function snapshotLive(live: LiveAiProvider): AiProviderSnapshot {
  return {
    name: live.name ?? '',
    schema: live.schema ?? '',
    host: live.host ?? '',
    port: live.port ?? 0,
    protocol: live.protocol ?? '',
  }
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

  const specs = extractAiProviderSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveAiProvider>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list AI providers: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveAiProvider>()
  const liveById = new Map<string, LiveAiProvider>()
  for (const p of listed.items) {
    if (p.name) liveByName.set(p.name.toLowerCase(), p)
    const id = liveAiProviderId(p)
    if (id) liveById.set(id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveAiProviderId(live) : undefined

    if (liveId) {
      const resp = await client.put(`${BASE}/${liveId}`, aiProviderBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, aiProviderBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractNpaObject<LiveAiProvider>(resp.body)
      const newId = created ? liveAiProviderId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete AI providers THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some AI providers failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} AI provider(s)`, rollbackData: { entries } }
}
