import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type GraphClient,
} from '../../lib/graph'
import {
  canonicalSetList,
  extractPermissionGrantPolicySpecs,
  parseArray,
  RESERVED_ID_PREFIX,
  stripConditionSet,
  type LivePermissionGrantPolicy,
  type PermissionGrantPolicySpec,
} from './validate'

const BASE = '/policies/permissionGrantPolicies'

export interface RollbackEntry {
  itemId?: string
  /** The policy id — identity and Graph resource key. */
  name: string
  existed: boolean
  id?: string
  prior?: {
    displayName?: string
    description?: string | null
    includes: Array<Record<string, unknown>>
    excludes: Array<Record<string, unknown>>
  }
}

export function buildMetaBody(spec: PermissionGrantPolicySpec): Record<string, unknown> {
  return { displayName: spec.displayName, description: spec.description || null }
}

/** Delete every owned condition set of `kind` and re-create the desired ones. */
export async function replaceConditionSets(
  client: GraphClient,
  policyId: string,
  kind: 'includes' | 'excludes',
  desired: Array<Record<string, unknown>>,
): Promise<string | null> {
  const current = await client.getAll<Record<string, unknown>>(`${BASE}/${policyId}/${kind}`)
  if (!current.ok) return graphErrorMessage(current.lastError!)
  for (const cs of current.items) {
    const id = cs.id
    if (typeof id === 'string') {
      const del = await client.delete(`${BASE}/${policyId}/${kind}/${id}`)
      if (!del.ok && del.status !== 404) return graphErrorMessage(del)
    }
  }
  for (const cs of desired) {
    const post = await client.post(`${BASE}/${policyId}/${kind}`, stripConditionSet(cs))
    if (!post.ok) return graphErrorMessage(post)
  }
  return null
}

/** Reconcile a condition-set collection idempotently, returning the prior sets. */
async function reconcileSets(
  client: GraphClient,
  policyId: string,
  kind: 'includes' | 'excludes',
  desired: Array<Record<string, unknown>>,
): Promise<{ prior: Array<Record<string, unknown>>; error?: string }> {
  const current = await client.getAll<Record<string, unknown>>(`${BASE}/${policyId}/${kind}`)
  if (!current.ok) return { prior: [], error: graphErrorMessage(current.lastError!) }
  const prior = current.items.map(stripConditionSet)
  if (canonicalSetList(current.items) === canonicalSetList(desired)) return { prior }
  const err = await replaceConditionSets(client, policyId, kind, desired)
  return err ? { prior, error: err } : { prior }
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

  const specs = extractPermissionGrantPolicySpecs(ctx.canvas).filter(
    (s) => s.id && !s.id.startsWith(RESERVED_ID_PREFIX),
  )

  const listed = await client.getAll<LivePermissionGrantPolicy>(`${BASE}?$select=id,displayName,description`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list permission grant policies: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveById = new Map<string, LivePermissionGrantPolicy>()
  for (const p of listed.items) {
    if (p.id) liveById.set(p.id.toLowerCase(), p)
  }

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const desiredIncludes = parseArray(spec.includes) ?? []
    const desiredExcludes = parseArray(spec.excludes) ?? []
    const live = liveById.get(spec.id) ?? null

    if (live) {
      const meta = await client.patch(`${BASE}/${spec.id}`, buildMetaBody(spec))
      if (!meta.ok) {
        failures.push(`${spec.id}: ${graphErrorMessage(meta)}`)
        continue
      }
      const incl = await reconcileSets(client, spec.id, 'includes', desiredIncludes)
      const excl = await reconcileSets(client, spec.id, 'excludes', desiredExcludes)
      if (incl.error || excl.error) {
        failures.push(`${spec.id}: ${incl.error ?? excl.error}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.id,
        existed: true,
        id: spec.id,
        prior: {
          displayName: live.displayName,
          description: live.description ?? null,
          includes: incl.prior,
          excludes: excl.prior,
        },
      })
    } else {
      const created = await client.post(BASE, { id: spec.id, ...buildMetaBody(spec) })
      if (!created.ok) {
        failures.push(`${spec.id}: ${graphErrorMessage(created)}`)
        continue
      }
      const inclErr = await replaceConditionSets(client, spec.id, 'includes', desiredIncludes)
      const exclErr = await replaceConditionSets(client, spec.id, 'excludes', desiredExcludes)
      if (inclErr || exclErr) {
        failures.push(`${spec.id}: ${inclErr ?? exclErr}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.id, existed: false, id: spec.id })
    }
  }

  // Reconcile: delete policies THIS app created previously but no longer declares.
  const declared = new Set(specs.map((s) => s.id))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declared.has(p.id) && !p.id.startsWith(RESERVED_ID_PREFIX)) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some permission grant policies failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} permission grant policy(ies)`,
    rollbackData: { entries },
  }
}
