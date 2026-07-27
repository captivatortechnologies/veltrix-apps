import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractNpaObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type NetskopeClient,
  type NetskopeResponse,
} from '../../lib/netskope'
import type { LivePolicyGroup } from '../npa-policy-groups/validate'
import { extractRuleSpecs, JSON_VERSION, liveRuleId, type LiveRule, type RuleSpec } from './validate'

const BASE = '/policy/npa/rules'
const LIST_KEY = 'rules'
const GROUPS_BASE = '/policy/npa/policygroups'
const GROUPS_LIST_KEY = 'policy_groups'
const CREATE_RETRY_DELAY_MS = 1_500

/** Desired-state rule body — also the shape stored for rollback restore. */
export interface RuleSnapshot {
  rule_name: string
  description: string
  enabled: string
  group_id?: string
  rule_data: Record<string, unknown>
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: RuleSnapshot
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function buildRuleBody(spec: RuleSpec, groupId?: string): RuleSnapshot {
  const body: RuleSnapshot = {
    rule_name: spec.name,
    description: spec.description,
    enabled: spec.enabled ? '1' : '0',
    rule_data: {
      policy_type: 'private-app',
      match_criteria_action: { action_name: spec.action },
      private_apps: spec.privateApps,
      private_app_tags: spec.privateAppTags,
      users: spec.users,
      user_groups: spec.userGroups,
      organization_units: spec.organizationUnits,
      access_method: spec.accessMethods,
      device_classification_id: spec.deviceClassificationIds,
      net_location_obj: spec.netLocationObjs,
      src_countries: spec.srcCountries,
      b_negate_net_location: spec.negateNetLocation,
      b_negate_src_countries: spec.negateSrcCountries,
      json_version: JSON_VERSION,
    },
  }
  if (groupId) body.group_id = groupId
  return body
}

function snapshotLive(live: LiveRule): RuleSnapshot {
  const d = live.rule_data ?? {}
  const snapshot: RuleSnapshot = {
    rule_name: live.rule_name ?? '',
    description: live.description ?? '',
    enabled: live.enabled === true || live.enabled === '1' ? '1' : '0',
    rule_data: {
      policy_type: d.policy_type ?? 'private-app',
      match_criteria_action: { action_name: d.match_criteria_action?.action_name ?? 'allow' },
      private_apps: d.private_apps ?? [],
      private_app_tags: d.private_app_tags ?? [],
      users: d.users ?? [],
      user_groups: d.user_groups ?? [],
      organization_units: d.organization_units ?? [],
      access_method: d.access_method ?? [],
      device_classification_id: d.device_classification_id ?? [],
      net_location_obj: d.net_location_obj ?? [],
      src_countries: d.src_countries ?? [],
      b_negate_net_location: d.b_negate_net_location === true,
      b_negate_src_countries: d.b_negate_src_countries === true,
      json_version: d.json_version ?? JSON_VERSION,
    },
  }
  if (live.group_id !== undefined && live.group_id !== null) snapshot.group_id = String(live.group_id)
  return snapshot
}

/** Rule create is eventually consistent — a referenced private-app or group that
 *  was created earlier in the same pipeline may not be resolvable yet. Retry the
 *  create once on a dependency-shaped error. */
function isEventualConsistency(resp: NetskopeResponse): boolean {
  return /not\s*found|does not exist|no such|invalid.*(app|group|private)/i.test(netskopeErrorMessage(resp))
}

async function createRule(client: NetskopeClient, body: RuleSnapshot): Promise<NetskopeResponse> {
  let resp = await client.post(BASE, body)
  if (!resp.ok && isEventualConsistency(resp)) {
    await sleep(CREATE_RETRY_DELAY_MS)
    resp = await client.post(BASE, body)
  }
  return resp
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

async function loadGroupMap(client: NetskopeClient): Promise<{ ok: boolean; byName: Map<string, string>; byId: Set<string>; error?: string }> {
  const byName = new Map<string, string>()
  const byId = new Set<string>()
  const listed = await client.getAllNpa<LivePolicyGroup>(GROUPS_BASE, GROUPS_LIST_KEY)
  if (!listed.ok) return { ok: false, byName, byId, error: netskopeErrorMessage(listed.lastError!) }
  for (const g of listed.items) {
    const id = g.id === undefined || g.id === null ? undefined : String(g.id)
    if (!id) continue
    byId.add(id)
    if (g.group_name) byName.set(g.group_name.toLowerCase(), id)
  }
  return { ok: true, byName, byId }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractRuleSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAllNpa<LiveRule>(BASE, LIST_KEY)
  if (!listed.ok) return { success: false, message: `Failed to list NPA rules: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveRule>()
  const liveById = new Map<string, LiveRule>()
  for (const r of listed.items) {
    if (r.rule_name) liveByName.set(r.rule_name.toLowerCase(), r)
    const id = liveRuleId(r)
    if (id) liveById.set(id, r)
  }

  const groupMap = await loadGroupMap(client)
  if (!groupMap.ok) return { success: false, message: `Failed to list NPA policy groups: ${groupMap.error}` }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    let groupId: string | undefined
    if (spec.group) {
      groupId = groupMap.byId.has(spec.group) ? spec.group : groupMap.byName.get(spec.group.toLowerCase())
      if (!groupId) {
        failures.push(`${spec.name}: unknown policy group "${spec.group}"`)
        continue
      }
    }

    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveRuleId(live) : undefined

    if (liveId) {
      const resp = await client.put(`${BASE}/${liveId}`, buildRuleBody(spec, groupId))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await createRule(client, buildRuleBody(spec, groupId))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractNpaObject<LiveRule>(resp.body)
      const newId = created ? liveRuleId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete rules THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some NPA rules failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} NPA rule(s)`, rollbackData: { entries } }
}
