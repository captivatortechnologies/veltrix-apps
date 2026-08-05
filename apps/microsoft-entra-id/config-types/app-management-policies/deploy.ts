import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  extractAppManagementSpecs,
  parseObject,
  type AppManagementSpec,
  type LiveAppManagementPolicy,
} from './validate'
import {
  buildPolicyTargetMaps,
  reconcilePolicyAppliesTo,
  resolvePolicyTargets,
  type PolicyAppliesToEntry,
} from '../lib/policyAppliesTo'

const BASE = '/policies/appManagementPolicies'
const SELECT = '?$select=id,displayName,description,isEnabled,restrictions'
/** The Graph relationship/nav-property name — identical on both the
 *  application/servicePrincipal target side and the /policies collection
 *  path (see lib/policyAppliesTo.ts header). */
const POLICY_TYPE_NAME = 'appManagementPolicies'
/** appManagementPolicy is assignable to EITHER an application or a service principal. */
const ALLOWED_KINDS = ['application', 'servicePrincipal'] as const

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
  /** Tracked appliesTo assignments, with provenance. */
  appliesTo?: PolicyAppliesToEntry[]
}

/** Body for POST / PATCH. Restrictions default to an empty object (no restrictions). */
export function buildBody(spec: AppManagementSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    description: spec.description || null,
    isEnabled: spec.isEnabled,
    restrictions: parseObject(spec.restrictions) ?? {},
  }
}

function snapshotLive(live: LiveAppManagementPolicy): Record<string, unknown> {
  return {
    displayName: live.displayName,
    description: live.description ?? null,
    isEnabled: live.isEnabled ?? false,
    restrictions: live.restrictions ?? {},
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

  const specs = extractAppManagementSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveAppManagementPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list app management policies: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveAppManagementPolicy>()
  const liveById = new Map<string, LiveAppManagementPolicy>()
  for (const p of listed.items) {
    if (p.displayName) liveByName.set(p.displayName.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  // appliesTo targets resolve against applications/service principals — a
  // picker-selected value passes straight through; a hand-typed display
  // name/id falls back to these live maps, built once for the whole deploy.
  const targetMaps = await buildPolicyTargetMaps(client)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    let policyId: string | undefined
    let entry: RollbackEntry

    if (liveMatch?.id) {
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      policyId = liveMatch.id
      entry = { itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) }
    } else {
      const resp = await client.post(BASE, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAppManagementPolicy>(resp.body)
      policyId = created?.id
      entry = { itemId: spec.itemId, name: spec.name, existed: false, id: created?.id }
    }

    if (policyId) {
      const targetResolution = resolvePolicyTargets(spec.appliesTo, targetMaps, ALLOWED_KINDS)
      if (targetResolution.missing.length) {
        failures.push(
          `${spec.name}: unknown appliesTo target(s) ${targetResolution.missing.join(', ')} — create/verify them first or fix the name`
        )
        entry.appliesTo = priorEntry?.appliesTo ?? []
      } else {
        const { entries: assigned, failures: assignFailures } = await reconcilePolicyAppliesTo(
          client,
          POLICY_TYPE_NAME,
          policyId,
          targetResolution.targets,
          priorEntry?.appliesTo ?? []
        )
        entry.appliesTo = assigned
        for (const f of assignFailures) failures.push(`${spec.name}: ${f}`)
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
      message: `Some app management policies failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} app management policy(ies)`,
    rollbackData: { entries },
  }
}
