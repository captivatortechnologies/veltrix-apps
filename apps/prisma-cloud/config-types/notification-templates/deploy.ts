import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  parseJson,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type PcClient,
} from '../../lib/prismacloud'
import { extractNotificationTemplateSpecs, type LiveNotificationTemplate, type NotificationTemplateSpec } from './validate'

const BASE = '/api/v1/tenant/notification-templates'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the template existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: { name: string; integrationType: string; integrationId: string; enabled: boolean; templateConfig: Record<string, unknown> | null }
}

export function notificationTemplateBody(spec: NotificationTemplateSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    integrationType: spec.integrationType,
    enabled: spec.enabled,
    templateConfig: spec.templateConfig ?? {},
  }
  if (spec.integrationId) body.integrationId = spec.integrationId
  return body
}

async function listTemplates(client: PcClient): Promise<{ ok: boolean; items: LiveNotificationTemplate[]; err?: string }> {
  const res = await client.get(BASE)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LiveNotificationTemplate[]>(res.body) ?? [] }
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

  const specs = extractNotificationTemplateSpecs(ctx.canvas).filter((s) => s.name && s.integrationType && !s.templateConfigError && s.templateConfig)

  const listed = await listTemplates(client)
  if (!listed.ok) return { success: false, message: `Failed to list notification templates: ${listed.err}` }
  const liveByName = new Map<string, LiveNotificationTemplate>()
  const liveById = new Map<string, LiveNotificationTemplate>()
  for (const t of listed.items) {
    if (t.name) liveByName.set(t.name.toLowerCase(), t)
    if (t.id) liveById.set(t.id, t)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const createdNames: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.put(`${BASE}/${live.id}`, notificationTemplateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        id: live.id,
        prior: {
          name: live.name ?? '',
          integrationType: live.integrationType ?? spec.integrationType,
          integrationId: live.integrationId ?? '',
          enabled: live.enabled ?? true,
          templateConfig: live.templateConfig ?? null,
        },
      })
    } else {
      const resp = await client.post(BASE, notificationTemplateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveNotificationTemplate>(resp.body)
      if (created?.id) {
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created.id })
      } else {
        createdNames.push(spec.name)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: priorEntry?.id })
      }
    }
  }

  // Resolve ids for freshly-created templates whose create returned no id.
  if (createdNames.length) {
    const relisted = await listTemplates(client)
    if (relisted.ok) {
      const byName = new Map(relisted.items.filter((t) => t.name).map((t) => [t.name!.toLowerCase(), t]))
      for (const e of entries) {
        if (!e.existed && !e.id) e.id = byName.get(e.name.toLowerCase())?.id
      }
    }
  }

  // Reconcile: delete templates THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some notification templates failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} notification template(s)`, rollbackData: { entries } }
}
