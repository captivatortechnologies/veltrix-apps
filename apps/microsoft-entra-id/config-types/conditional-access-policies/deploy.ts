import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type GraphClient,
} from '../../lib/graph'
import {
  extractPolicySpecs,
  mapCanvasStateToGraph,
  type CaPolicySpec,
  type LiveCaPolicy,
} from './validate'

const BASE = '/identity/conditionalAccess/policies'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the policy existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/** Build a case-insensitive group displayName → id map from the live directory. */
export async function buildGroupNameToId(client: GraphClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const listed = await client.getAll<{ id?: string; displayName?: string }>('/groups?$select=id,displayName')
  if (listed.ok) {
    for (const g of listed.items) {
      if (g.displayName && g.id) map.set(g.displayName.toLowerCase(), g.id)
    }
  }
  return map
}

/** Resolve group display names to ids; unresolved names are returned separately. */
export function resolveGroups(
  names: string[],
  nameToId: Map<string, string>
): { ids: string[]; missing: string[] } {
  const ids: string[] = []
  const missing: string[] = []
  for (const n of names) {
    const id = nameToId.get(n.toLowerCase())
    if (id) ids.push(id)
    else missing.push(n)
  }
  return { ids, missing }
}

export function buildPolicyBody(
  spec: CaPolicySpec,
  includeGroupIds: string[],
  excludeGroupIds: string[]
): Record<string, unknown> {
  return {
    displayName: spec.name,
    state: mapCanvasStateToGraph(spec.state),
    conditions: {
      users: {
        includeUsers: spec.includeAllUsers ? ['All'] : [],
        includeGroups: spec.includeAllUsers ? [] : includeGroupIds,
        excludeGroups: excludeGroupIds,
      },
      applications: {
        includeApplications: spec.includeAllApps ? ['All'] : spec.includeApps,
      },
      clientAppTypes: ['all'],
    },
    grantControls: {
      operator: spec.grantOperator,
      builtInControls: spec.builtInControls,
    },
  }
}

function snapshotLive(live: LiveCaPolicy): Record<string, unknown> {
  return {
    displayName: live.displayName,
    state: live.state,
    conditions: live.conditions ?? {},
    grantControls: live.grantControls ?? null,
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

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveCaPolicy>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list Conditional Access policies: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveCaPolicy>()
  const liveById = new Map<string, LiveCaPolicy>()
  for (const p of listed.items) {
    if (p.displayName) liveByName.set(p.displayName.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  // Resolve group names once for the whole deploy.
  const nameToId = await buildGroupNameToId(client)

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const inc = resolveGroups(spec.includeAllUsers ? [] : spec.includeGroups, nameToId)
    const exc = resolveGroups(spec.excludeGroups, nameToId)
    const missing = [...inc.missing, ...exc.missing]
    if (missing.length) {
      failures.push(`${spec.name}: unknown group(s) ${missing.join(', ')} — create the group(s) first or fix the name`)
      continue
    }
    const body = buildPolicyBody(spec, inc.ids, exc.ids)

    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveCaPolicy>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
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
      message: `Some policies failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} Conditional Access policy(ies)`,
    rollbackData: { entries },
  }
}
