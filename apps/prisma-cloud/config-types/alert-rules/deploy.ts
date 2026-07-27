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
import { extractAlertRuleSpecs, type AlertRuleSpec, type LiveAlertRule } from './validate'

const BASE = '/v2/alert/rule'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the rule existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  /** the full prior rule object, restored verbatim on rollback. */
  prior?: Record<string, unknown>
}

export function alertRuleBody(spec: AlertRuleSpec): Record<string, unknown> {
  const target: Record<string, unknown> = {
    accountGroups: spec.accountGroups,
    excludedAccounts: spec.excludedAccounts,
    regions: spec.regions,
  }
  if (spec.tags.length) target.tags = spec.tags

  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    scanAll: spec.scanAll,
    policies: spec.policies,
    policyLabels: spec.policyLabels,
    excludedPolicies: spec.excludedPolicies,
    allowAutoRemediate: spec.allowAutoRemediate,
    notifyOnOpen: spec.notifyOnOpen,
    notifyOnDismissed: spec.notifyOnDismissed,
    notifyOnSnoozed: spec.notifyOnSnoozed,
    notifyOnResolved: spec.notifyOnResolved,
    target,
  }
  if (spec.delayNotificationMs !== undefined) body.delayNotificationMs = spec.delayNotificationMs
  if (spec.notificationConfig.length) body.alertRuleNotificationConfig = spec.notificationConfig
  return body
}

async function listRules(client: PcClient): Promise<{ ok: boolean; items: LiveAlertRule[]; err?: string }> {
  const res = await client.get(BASE)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LiveAlertRule[]>(res.body) ?? [] }
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

  const specs = extractAlertRuleSpecs(ctx.canvas).filter(
    (s) => s.name && s.accountGroups.length > 0 && !s.tagsError && !s.notificationConfigError
  )

  const listed = await listRules(client)
  if (!listed.ok) return { success: false, message: `Failed to list alert rules: ${listed.err}` }
  const liveByName = new Map<string, LiveAlertRule>()
  const liveById = new Map<string, LiveAlertRule>()
  for (const r of listed.items) {
    if (r.name) liveByName.set(r.name.toLowerCase(), r)
    if (r.policyScanConfigId) liveById.set(r.policyScanConfigId, r)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const createdNames: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (live?.policyScanConfigId) {
      const resp = await client.put(`${BASE}/${live.policyScanConfigId}`, alertRuleBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.policyScanConfigId, prior: live as Record<string, unknown> })
    } else {
      // POST /v2/alert/rule returns no usable body — resolve the id after by re-listing.
      const resp = await client.post(BASE, alertRuleBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      createdNames.push(spec.name)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: priorEntry?.id })
    }
  }

  // Resolve ids for freshly-created rules.
  if (createdNames.length) {
    const relisted = await listRules(client)
    if (relisted.ok) {
      const byName = new Map(relisted.items.filter((r) => r.name).map((r) => [r.name!.toLowerCase(), r]))
      for (const e of entries) {
        if (!e.existed && !e.id) e.id = byName.get(e.name.toLowerCase())?.policyScanConfigId
      }
    }
  }

  // Reconcile: delete alert rules THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some alert rules failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} alert rule(s)`, rollbackData: { entries } }
}
