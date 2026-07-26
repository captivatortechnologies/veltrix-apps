import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/duo'
import { extractIntegrationSpecs, type LiveIntegration } from './validate'

const BASE = '/admin/v1/integrations'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  /** Duo integration_key assigned to the integration. */
  integrationKey?: string
  prior?: { name: string }
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
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const specs = extractIntegrationSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveIntegration>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list integrations: ${duoErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveIntegration>()
  const liveByKey = new Map<string, LiveIntegration>()
  for (const g of listed.items) {
    if (g.name) liveByName.set(g.name.toLowerCase(), g)
    if (g.integration_key) liveByKey.set(g.integration_key, g)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.integrationKey ? liveByKey.get(priorEntry.integrationKey) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.integration_key) {
      // type is immutable — never replace an integration whose type differs.
      if (live.type && spec.type && live.type !== spec.type) {
        failures.push(`${spec.name}: an integration with this name exists with type "${live.type}" — type is immutable, so rename or delete it first`)
        continue
      }
      const resp = await client.post(`${BASE}/${live.integration_key}`, { name: spec.name })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${duoErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, integrationKey: live.integration_key, prior: { name: live.name ?? '' } })
    } else {
      const resp = await client.post(BASE, { name: spec.name, type: spec.type })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${duoErrorMessage(resp)}`)
        continue
      }
      const created = resp.response as LiveIntegration | null
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, integrationKey: created?.integration_key })
    }
  }

  // Reconcile: delete integrations THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptKeys = new Set(entries.map((e) => e.integrationKey).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.integrationKey && !keptKeys.has(p.integrationKey) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.integrationKey}`)
      if (!resp.ok) failures.push(`delete ${p.name}: ${duoErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some integrations failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} integration(s)`, rollbackData: { entries } }
}
