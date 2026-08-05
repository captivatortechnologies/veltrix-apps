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
import { extractIntegrationSpecs, type IntegrationSpec, type LiveIntegration } from './validate'

const BASE = '/integrations'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the integration existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: { name: string; description: string; enabled: boolean; integrationConfig: Record<string, unknown> }
}

/** integrationConfig is shaped per integrationType — see api-integration-config.md. */
export function integrationConfigBody(spec: IntegrationSpec): Record<string, unknown> {
  if (spec.integrationType === 'aws_security_hub') {
    const cfg: Record<string, unknown> = { regions: spec.regions, accountId: spec.accountId }
    if (spec.defaultRegion) cfg.defaultRegion = spec.defaultRegion
    return cfg
  }
  if (spec.integrationType === 'google_cscc') {
    return { orgId: spec.orgId, sourceId: spec.sourceId }
  }
  return {}
}

/** POST body — note: no `enabled` field, integrations are created enabled. */
export function createBody(spec: IntegrationSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    integrationType: spec.integrationType,
    integrationConfig: integrationConfigBody(spec),
  }
}

/** PUT body — note: integrationType is NOT accepted on update; it is immutable after create. */
export function updateBody(spec: IntegrationSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    integrationConfig: integrationConfigBody(spec),
  }
}

async function listIntegrations(client: PcClient): Promise<{ ok: boolean; items: LiveIntegration[]; err?: string }> {
  const res = await client.get(BASE)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LiveIntegration[]>(res.body) ?? [] }
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

  const specs = extractIntegrationSpecs(ctx.canvas).filter((s) => s.name && s.integrationType)

  const listed = await listIntegrations(client)
  if (!listed.ok) return { success: false, message: `Failed to list integrations: ${listed.err}` }
  const liveByName = new Map<string, LiveIntegration>()
  const liveById = new Map<string, LiveIntegration>()
  for (const it of listed.items) {
    if (it.name) liveByName.set(it.name.toLowerCase(), it)
    if (it.id) liveById.set(it.id, it)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.id) {
      if (live.integrationType && live.integrationType !== spec.integrationType) {
        failures.push(
          `${spec.name}: integrationType is immutable (live "${live.integrationType}" != declared "${spec.integrationType}"); delete and recreate under a new name to change type`
        )
        entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: snapshotPrior(live) })
        continue
      }
      const resp = await client.put(`${BASE}/${live.id}`, updateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: snapshotPrior(live) })
    } else {
      const resp = await client.post(BASE, createBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveIntegration>(resp.body)
      if (!created?.id) {
        failures.push(`${spec.name}: created but the API returned no integration id`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created.id })
    }
  }

  // Reconcile: delete integrations THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some integrations failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} integration(s)`, rollbackData: { entries } }
}

function snapshotPrior(live: LiveIntegration): RollbackEntry['prior'] {
  return {
    name: live.name ?? '',
    description: (live.description ?? '') as string,
    enabled: live.enabled ?? true,
    integrationConfig: live.integrationConfig ?? {},
  }
}
