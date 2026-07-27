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
  combinationsEqual,
  extractAuthStrengthSpecs,
  isCustomPolicy,
  type AuthStrengthSpec,
  type LiveAuthStrengthPolicy,
} from './validate'

const BASE = '/policies/authenticationStrengthPolicies'
const SELECT = '?$select=id,displayName,description,policyType,allowedCombinations'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: { displayName?: string; description?: string | null; allowedCombinations?: string[] }
}

/** Body for POST — a new custom policy with its allowed combinations. */
export function buildCreateBody(spec: AuthStrengthSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    description: spec.description || null,
    allowedCombinations: spec.combinations,
  }
}

/** Body for PATCH — metadata only; combinations use a separate action. */
export function buildPatchBody(spec: AuthStrengthSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    description: spec.description || null,
  }
}

function snapshotLive(live: LiveAuthStrengthPolicy): RollbackEntry['prior'] {
  return {
    displayName: live.displayName,
    description: live.description ?? null,
    allowedCombinations: live.allowedCombinations ?? [],
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

  const specs = extractAuthStrengthSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveAuthStrengthPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list authentication strengths: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveAuthStrengthPolicy>()
  const liveById = new Map<string, LiveAuthStrengthPolicy>()
  for (const p of listed.items) {
    if (p.displayName) liveByName.set(p.displayName.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      // Never touch a built-in authentication strength — it can't be modified.
      if (!isCustomPolicy(liveMatch)) {
        failures.push(`${spec.name}: a built-in authentication strength with this name exists and will not be modified`)
        continue
      }
      const patched = await client.patch(`${BASE}/${liveMatch.id}`, buildPatchBody(spec))
      if (!patched.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(patched)}`)
        continue
      }
      // Combinations must be changed via the dedicated action, and only when they differ.
      if (!combinationsEqual(spec.combinations, liveMatch.allowedCombinations ?? [])) {
        const combo = await client.post(`${BASE}/${liveMatch.id}/updateAllowedCombinations`, {
          allowedCombinations: spec.combinations,
        })
        if (!combo.ok) {
          failures.push(`${spec.name}: ${graphErrorMessage(combo)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAuthStrengthPolicy>(resp.body)
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
      message: `Some authentication strengths failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} authentication strength(s)`,
    rollbackData: { entries },
  }
}
