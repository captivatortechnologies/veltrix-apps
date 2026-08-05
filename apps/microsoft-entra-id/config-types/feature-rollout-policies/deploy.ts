import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractFeatureRolloutSpecs, type FeatureRolloutSpec, type LiveFeatureRolloutPolicy } from './validate'
import { buildGroupNameToId, resolveRefs } from '../lib/nameMaps'
import { reconcileRefCollection, type RefMemberEntry } from '../lib/refReconcile'

const BASE = '/policies/featureRolloutPolicies'
const SELECT = '?$select=id,displayName,feature,isEnabled,isAppliedToOrganization'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
  /** Tracked appliesTo group assignments, with provenance — see RefMemberEntry. */
  appliesTo?: RefMemberEntry[]
}

/** Create body includes the (immutable) feature; PATCH body omits it. */
export function buildCreateBody(spec: FeatureRolloutSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    feature: spec.feature,
    isEnabled: spec.isEnabled,
    isAppliedToOrganization: spec.isAppliedToOrganization,
  }
}

export function buildPatchBody(spec: FeatureRolloutSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    isEnabled: spec.isEnabled,
    isAppliedToOrganization: spec.isAppliedToOrganization,
  }
}

function snapshotLive(live: LiveFeatureRolloutPolicy): Record<string, unknown> {
  return {
    displayName: live.displayName,
    isEnabled: live.isEnabled ?? false,
    isAppliedToOrganization: live.isAppliedToOrganization ?? false,
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
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractFeatureRolloutSpecs(ctx.canvas).filter((s) => s.name && s.feature)

  const listed = await client.getAll<LiveFeatureRolloutPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list feature rollout policies: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveFeatureRolloutPolicy>()
  const liveById = new Map<string, LiveFeatureRolloutPolicy>()
  for (const p of listed.items) {
    if (p.displayName) liveByName.set(p.displayName.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  // appliesTo group references resolve against the live directory — a
  // picker-selected value passes straight through; a hand-typed display name
  // falls back to this live map.
  const groupNameToId = await buildGroupNameToId(client)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    let policyId: string | undefined
    let entry: RollbackEntry

    if (liveMatch?.id) {
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildPatchBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      policyId = liveMatch.id
      entry = { itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) }
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveFeatureRolloutPolicy>(resp.body)
      policyId = created?.id
      entry = { itemId: spec.itemId, name: spec.name, existed: false, id: created?.id }
    }

    if (policyId) {
      const groupResolution = resolveRefs(spec.appliesTo, groupNameToId)
      if (groupResolution.missing.length) {
        failures.push(
          `${spec.name}: unknown appliesTo group(s) ${groupResolution.missing.join(', ')} — create/verify them first or fix the name`
        )
        // Leave appliesTo exactly as last tracked — don't touch Graph until every group resolves.
        entry.appliesTo = priorEntry?.appliesTo ?? []
      } else {
        const { members, failures: appliesToFailures } = await reconcileRefCollection(
          client,
          `${BASE}/${policyId}`,
          'appliesTo',
          groupResolution.ids,
          priorEntry?.appliesTo ?? []
        )
        entry.appliesTo = members
        for (const f of appliesToFailures) failures.push(`${spec.name}: ${f}`)
      }
    }

    entries.push(entry)
  }

  // Reconcile: delete policies THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some feature rollout policies failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} feature rollout policy(ies)`,
    rollbackData: { entries },
  }
}
