import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/mimecast'
import { extractAntiSpoofingBypassSpecs, type AntiSpoofingBypassSpec, type LivePolicy } from './validate'

const CREATE = '/api/policy/antispoofing-bypass/create-policy'
const GET_ALL = '/api/policy/antispoofing-bypass/get-policy'
const DELETE = '/api/policy/antispoofing-bypass/delete-policy'

export interface RollbackEntry {
  itemId?: string
  /** the policy description (its logical identity). */
  name: string
  existed: boolean
  id?: string
  /** the create payload, so rollback can recreate the prior policy. */
  prior?: Record<string, unknown>
}

function buildBlock(type: string, value: string): Record<string, unknown> {
  if (type === 'email_domain') return { type, emailDomain: value }
  if (type === 'email_address') return { type, emailAddress: value }
  return { type: 'everyone' }
}

/** Normalize an SPF domain list for stable comparison. */
export function normDomains(list?: string[]): string {
  return (list ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean).sort().join(',')
}

export function buildPayload(spec: AntiSpoofingBypassSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    option: spec.option,
    policy: { description: spec.description, from: buildBlock(spec.fromType, spec.fromValue), to: buildBlock(spec.toType, spec.toValue) },
  }
  if (spec.spfDomains.length) payload.conditions = { spfDomains: spec.spfDomains }
  return payload
}

function blockValue(b?: { type?: string; emailAddress?: string; emailDomain?: string }): string {
  if (!b) return ''
  if (b.type === 'email_domain') return `email_domain:${(b.emailDomain ?? '').toLowerCase()}`
  if (b.type === 'email_address') return `email_address:${(b.emailAddress ?? '').toLowerCase()}`
  return 'everyone'
}

/** Recreate the prior policy's create payload from a live policy. */
export function snapshotLive(live: LivePolicy): Record<string, unknown> {
  const snap: Record<string, unknown> = {
    option: live.option ?? 'enable_bypass',
    policy: { description: live.policy?.description ?? '', from: live.policy?.from ?? { type: 'everyone' }, to: live.policy?.to ?? { type: 'everyone' } },
  }
  if (live.conditions?.spfDomains?.length) snap.conditions = { spfDomains: live.conditions.spfDomains }
  return snap
}

/** Whether a live policy already equals the desired spec (description matches). */
export function definitionEquals(live: LivePolicy, spec: AntiSpoofingBypassSpec): boolean {
  if ((live.option ?? '') !== spec.option) return false
  if (blockValue(live.policy?.from) !== blockValue(buildBlock(spec.fromType, spec.fromValue) as { type?: string; emailAddress?: string; emailDomain?: string })) return false
  if (blockValue(live.policy?.to) !== blockValue(buildBlock(spec.toType, spec.toValue) as { type?: string; emailAddress?: string; emailDomain?: string })) return false
  return normDomains(live.conditions?.spfDomains) === normDomains(spec.spfDomains)
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

  const specs = extractAntiSpoofingBypassSpecs(ctx.canvas).filter((s) => s.description)

  const listed = await client.request(GET_ALL, {})
  if (!listed.ok) return { success: false, message: `Failed to list anti-spoofing bypass policies: ${mimecastErrorMessage(listed)}` }
  const liveByDesc = new Map<string, LivePolicy>()
  for (const p of listed.data as LivePolicy[]) {
    const d = p.policy?.description
    if (d) liveByDesc.set(d.toLowerCase(), p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByDesc = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const key = spec.description.toLowerCase()
    const live = liveByDesc.get(key) ?? null
    const priorEntry = priorByDesc.get(key)

    let existed: boolean
    let priorSnap: Record<string, unknown> | undefined
    if (priorEntry) {
      existed = priorEntry.existed
      priorSnap = priorEntry.prior
    } else if (live) {
      existed = true
      priorSnap = snapshotLive(live)
    } else {
      existed = false
      priorSnap = undefined
    }

    if (live?.id && definitionEquals(live, spec)) {
      entries.push({ itemId: spec.itemId, name: spec.description, existed, id: live.id, prior: priorSnap })
      continue
    }

    // No safe in-place update — delete the old one (if any) and create the desired.
    if (live?.id) {
      const del = await client.request(DELETE, { id: live.id })
      if (!del.ok) {
        failures.push(`${spec.description}: ${mimecastErrorMessage(del)}`)
        continue
      }
    }
    const resp = await client.request(CREATE, buildPayload(spec))
    if (!resp.ok) {
      failures.push(`${spec.description}: ${mimecastErrorMessage(resp)}`)
      continue
    }
    const created = resp.data[0] as { id?: string } | undefined
    entries.push({ itemId: spec.itemId, name: spec.description, existed, id: created?.id, prior: priorSnap })
  }

  // Reconcile: delete policies THIS app created previously but no longer declares.
  const declaredKeys = new Set(specs.map((s) => s.description.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredKeys.has(p.name.toLowerCase())) {
      const del = await client.request(DELETE, { id: p.id })
      if (!del.ok) failures.push(`delete ${p.name}: ${mimecastErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some anti-spoofing bypass policies failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} anti-spoofing bypass policy(ies)`, rollbackData: { entries } }
}
