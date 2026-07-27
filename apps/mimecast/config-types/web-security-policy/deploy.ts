import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/mimecast'
import {
  extractWebSecurityPolicySpecs,
  urlIdentity,
  type LiveWebPolicy,
  type WebSecurityPolicySpec,
  type WebUrl,
} from './validate'

const CREATE = '/api/policy/webwhiteurl/create-policy-with-targets'
const GET_ALL = '/api/policy/webwhiteurl/get-policies'
const DELETE = '/api/policy/webwhiteurl/delete-policy'

export interface RollbackEntry {
  itemId?: string
  /** the policy description (its logical identity). */
  name: string
  existed: boolean
  id?: string
  /** the create payload, so rollback can recreate the prior policy. */
  prior?: Record<string, unknown>
}

type TargetBlock = { type?: string; emailAddress?: string; emailDomain?: string; groupId?: string }

export function buildTarget(type: string, value: string): Record<string, unknown> {
  if (type === 'email_domain') return { type, emailDomain: value }
  if (type === 'individual_email_address') return { type, emailAddress: value }
  return { type: 'everyone' }
}

export function buildPayload(spec: WebSecurityPolicySpec): Record<string, unknown> {
  return {
    description: spec.description,
    urls: spec.urls.map((u) => ({ action: u.action, type: u.type, value: u.value })),
    policies: [
      {
        description: spec.description,
        enabled: spec.enabled,
        enforced: false,
        override: false,
        bidirectional: false,
        from: buildTarget(spec.fromType, spec.fromValue),
        to: buildTarget(spec.toType, spec.toValue),
      },
    ],
  }
}

function targetValue(b?: TargetBlock): string {
  if (!b) return 'everyone'
  if (b.type === 'email_domain') return `email_domain:${(b.emailDomain ?? '').toLowerCase()}`
  if (b.type === 'individual_email_address') return `individual_email_address:${(b.emailAddress ?? '').toLowerCase()}`
  return b.type ?? 'everyone'
}

function livePolicyDetail(live: LiveWebPolicy): { enabled: boolean; from?: TargetBlock; to?: TargetBlock } {
  const detail = live.policies?.[0]?.policy
  return { enabled: detail?.enabled ?? true, from: detail?.from, to: detail?.to }
}

function liveUrlSet(live: LiveWebPolicy): Set<string> {
  return new Set((live.urls ?? []).map((u) => urlIdentity({ action: (u.action ?? '').toLowerCase(), type: (u.type ?? '').toLowerCase(), value: u.value ?? '' })))
}

/** Recreate a create payload from a live policy, so rollback can restore it. */
export function snapshotLive(live: LiveWebPolicy): Record<string, unknown> {
  const detail = livePolicyDetail(live)
  return {
    description: live.description ?? '',
    urls: (live.urls ?? []).map((u) => ({ action: u.action, type: u.type, value: u.value })),
    policies: [
      {
        description: live.description ?? '',
        enabled: detail.enabled,
        enforced: false,
        override: false,
        bidirectional: false,
        from: detail.from ?? { type: 'everyone' },
        to: detail.to ?? { type: 'everyone' },
      },
    ],
  }
}

/** Whether a live policy already equals the desired spec. */
export function definitionEquals(live: LiveWebPolicy, spec: WebSecurityPolicySpec): boolean {
  const detail = livePolicyDetail(live)
  if (detail.enabled !== spec.enabled) return false
  if (targetValue(detail.from) !== targetValue(buildTarget(spec.fromType, spec.fromValue) as TargetBlock)) return false
  if (targetValue(detail.to) !== targetValue(buildTarget(spec.toType, spec.toValue) as TargetBlock)) return false
  const liveUrls = liveUrlSet(live)
  const desiredUrls = new Set(spec.urls.map((u: WebUrl) => urlIdentity(u)))
  if (liveUrls.size !== desiredUrls.size) return false
  for (const id of desiredUrls) if (!liveUrls.has(id)) return false
  return true
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

  const specs = extractWebSecurityPolicySpecs(ctx.canvas).filter((s) => s.description && s.urls.length > 0)

  const listed = await client.request(GET_ALL, {})
  if (!listed.ok) return { success: false, message: `Failed to list web security policies: ${mimecastErrorMessage(listed)}` }
  const liveByDesc = new Map<string, LiveWebPolicy>()
  for (const p of listed.data as LiveWebPolicy[]) {
    const d = p.description
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

    // create-policy-with-targets has no partial-update contract here — delete
    // the old policy (if any) and recreate it to match the declared spec.
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
    return { success: false, message: `Some web security policies failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} web security policy(ies)`, rollbackData: { entries } }
}
