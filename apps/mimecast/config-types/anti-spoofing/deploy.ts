import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  extractV1List,
  readMimecastSettings,
  resolveMimecastCredential,
  v1ErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/mimecast'
import { buildTargetV1, targetValueV1, normListV1 } from '../../lib/policyTargetV1'
import { extractAntiSpoofingSpecs, type AntiSpoofingSpec, type LiveAntiSpoofingPolicy } from './validate'

const LIST = '/policy-management/cloud-gateway/v1/anti-spoofing/policies'
const ITEM = (id: string): string => `${LIST}/${id}`

export interface RollbackEntry {
  itemId?: string
  /** the policy description (its logical identity). */
  name: string
  existed: boolean
  id?: string
  /** the create/update payload, so rollback can restore the prior policy. */
  prior?: Record<string, unknown>
}

export function buildPayload(spec: AntiSpoofingSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    description: spec.description,
    option: spec.option,
    fromPart: spec.fromPart,
    from: buildTargetV1(spec.fromType, spec.fromValue),
    to: buildTargetV1(spec.toType, spec.toValue),
    override: spec.override,
    bidirectional: spec.bidirectional,
  }
  if (spec.sourceIPs.length) payload.sourceIPs = spec.sourceIPs
  if (spec.hostnames.length) payload.hostnames = spec.hostnames
  return payload
}

/** Recreate the payload for a live policy, so rollback can restore it via PATCH. */
export function snapshotLive(live: LiveAntiSpoofingPolicy): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    description: live.description ?? '',
    option: live.option ?? 'apply',
    fromPart: live.fromPart ?? 'envelope_from',
    from: live.from ?? { type: 'everyone' },
    to: live.to ?? { type: 'everyone' },
    override: live.override ?? false,
    bidirectional: live.bidirectional ?? false,
  }
  if (live.sourceIPs?.length) payload.sourceIPs = live.sourceIPs
  if (live.hostnames?.length) payload.hostnames = live.hostnames
  return payload
}

/** Whether a live policy already equals the desired spec. */
export function definitionEquals(live: LiveAntiSpoofingPolicy, spec: AntiSpoofingSpec): boolean {
  if ((live.option ?? '') !== spec.option) return false
  if ((live.fromPart ?? 'envelope_from') !== spec.fromPart) return false
  if ((live.override ?? false) !== spec.override) return false
  if ((live.bidirectional ?? false) !== spec.bidirectional) return false
  if (targetValueV1(live.from) !== targetValueV1(buildTargetV1(spec.fromType, spec.fromValue))) return false
  if (targetValueV1(live.to) !== targetValueV1(buildTargetV1(spec.toType, spec.toValue))) return false
  if (normListV1(live.sourceIPs) !== normListV1(spec.sourceIPs)) return false
  return normListV1(live.hostnames) === normListV1(spec.hostnames)
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
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildMimecastClient(cred, settings)

  const specs = extractAntiSpoofingSpecs(ctx.canvas).filter((s) => s.description)

  const listed = await client.requestV1('GET', LIST, { query: { pageSize: 100 } })
  if (!listed.ok) return { success: false, message: `Failed to list anti-spoofing policies: ${listed.error ?? v1ErrorMessage(listed.body, listed.status)}` }
  const liveByDesc = new Map<string, LiveAntiSpoofingPolicy>()
  for (const p of extractV1List<LiveAntiSpoofingPolicy>(listed.body)) {
    if (p.description) liveByDesc.set(p.description.toLowerCase(), p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByDesc = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const key = spec.description.toLowerCase()
    const live = liveByDesc.get(key) ?? null
    const priorEntry = priorByDesc.get(key)

    const existed = priorEntry ? priorEntry.existed : Boolean(live)
    const priorSnap = priorEntry ? priorEntry.prior : live ? snapshotLive(live) : undefined

    if (live?.id && definitionEquals(live, spec)) {
      entries.push({ itemId: spec.itemId, name: spec.description, existed, id: live.id, prior: priorSnap })
      continue
    }

    const payload = buildPayload(spec)

    if (live?.id) {
      // The v1 API supports a real update — PATCH the existing policy in place
      // rather than deleting and recreating it (unlike every legacy policy
      // type in this app).
      const patched = await client.requestV1('PATCH', ITEM(live.id), { body: payload })
      if (!patched.ok) {
        failures.push(`${spec.description}: ${patched.error ?? v1ErrorMessage(patched.body, patched.status)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.description, existed, id: live.id, prior: priorSnap })
      continue
    }

    const created = await client.requestV1<{ id?: string }>('POST', LIST, { body: payload })
    if (!created.ok) {
      failures.push(`${spec.description}: ${created.error ?? v1ErrorMessage(created.body, created.status)}`)
      continue
    }
    entries.push({ itemId: spec.itemId, name: spec.description, existed, id: created.body?.id, prior: priorSnap })
  }

  // Reconcile: delete policies THIS app created previously but no longer declares.
  const declaredKeys = new Set(specs.map((s) => s.description.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredKeys.has(p.name.toLowerCase())) {
      const del = await client.requestV1('DELETE', ITEM(p.id))
      if (!del.ok) failures.push(`delete ${p.name}: ${del.error ?? v1ErrorMessage(del.body, del.status)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some anti-spoofing policies failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} anti-spoofing policy(ies)`, rollbackData: { entries } }
}
