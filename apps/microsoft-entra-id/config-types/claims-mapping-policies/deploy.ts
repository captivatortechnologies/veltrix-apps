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
  extractClaimsMappingSpecs,
  type ClaimsMappingSpec,
  type LiveClaimsMappingPolicy,
} from './validate'
import {
  buildPolicyTargetMaps,
  reconcilePolicyAppliesTo,
  resolvePolicyTargets,
  type PolicyAppliesToEntry,
} from '../lib/policyAppliesTo'

const BASE = '/policies/claimsMappingPolicies'
const SELECT = '?$select=id,displayName,definition'
const POLICY_TYPE_NAME = 'claimsMappingPolicies'
/** claimsMappingPolicy is assignable to service principals ONLY — its own
 *  isOrganizationDefault property description confirms this: "The
 *  claims-mapping policy can only be applied to service principals."
 *  (https://learn.microsoft.com/graph/api/resources/claimsmappingpolicy) */
const ALLOWED_KINDS = ['servicePrincipal'] as const

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
  /** Tracked appliesTo assignments, with provenance. */
  appliesTo?: PolicyAppliesToEntry[]
}

/** Body for POST / PATCH — the definition is stored as a single-element string array. */
export function buildBody(spec: ClaimsMappingSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    definition: [spec.definition],
  }
}

function snapshotLive(live: LiveClaimsMappingPolicy): Record<string, unknown> {
  return {
    displayName: live.displayName,
    definition: live.definition ?? [],
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

  const specs = extractClaimsMappingSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveClaimsMappingPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list claims mapping policies: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveClaimsMappingPolicy>()
  const liveById = new Map<string, LiveClaimsMappingPolicy>()
  for (const p of listed.items) {
    if (p.displayName) liveByName.set(p.displayName.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

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
      const created = parseJson<LiveClaimsMappingPolicy>(resp.body)
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
      message: `Some claims mapping policies failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} claims mapping policy(ies)`,
    rollbackData: { entries },
  }
}
