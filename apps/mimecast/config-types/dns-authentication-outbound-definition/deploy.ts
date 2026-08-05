import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  extractV1List,
  readMimecastSettings,
  resolveMimecastCredential,
  v1ErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/mimecast'
import { extractDnsAuthOutboundDefinitionSpecs, type DnsAuthOutboundDefinitionSpec, type LiveDnsAuthOutboundDefinition } from './validate'

const LIST = '/policy-management/cloud-gateway/v1/dns-authentication-outbound/definitions'
const ITEM = (id: string): string => `${LIST}/${id}`

export interface RollbackEntry {
  itemId?: string
  /** the definition description (its logical identity). */
  name: string
  existed: boolean
  id?: string
  /** the create/update payload, so rollback can restore the prior definition. */
  prior?: Record<string, unknown>
}

export function buildPayload(spec: DnsAuthOutboundDefinitionSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    description: spec.description,
    domain: spec.domain,
    signDkim: spec.signDkim,
    keyLength: spec.keyLength,
  }
  if (spec.selector) payload.selector = spec.selector
  return payload
}

/** Recreate the payload for a live definition, so rollback can restore it via PATCH. */
export function snapshotLive(live: LiveDnsAuthOutboundDefinition): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    description: live.description ?? '',
    domain: live.domain ?? '',
    signDkim: live.signDkim ?? true,
    keyLength: live.keyLength ?? 2048,
  }
  if (live.selector) payload.selector = live.selector
  return payload
}

/**
 * Whether a live definition already equals the desired spec. The selector is
 * only compared when explicitly declared — an undeclared selector means
 * "whatever Mimecast generated", which this config type does not manage.
 */
export function definitionEquals(live: LiveDnsAuthOutboundDefinition, spec: DnsAuthOutboundDefinitionSpec): boolean {
  if ((live.domain ?? '') !== spec.domain) return false
  if ((live.signDkim ?? true) !== spec.signDkim) return false
  if ((live.keyLength ?? 2048) !== spec.keyLength) return false
  if (spec.selector && (live.selector ?? '') !== spec.selector) return false
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

  const specs = extractDnsAuthOutboundDefinitionSpecs(ctx.canvas).filter((s) => s.description && s.domain)

  const listed = await client.requestV1('GET', LIST, { query: { pageSize: 100 } })
  if (!listed.ok)
    return { success: false, message: `Failed to list DNS Authentication - Outbound definitions: ${listed.error ?? v1ErrorMessage(listed.body, listed.status)}` }
  const liveByDesc = new Map<string, LiveDnsAuthOutboundDefinition>()
  for (const d of extractV1List<LiveDnsAuthOutboundDefinition>(listed.body)) {
    if (d.description) liveByDesc.set(d.description.toLowerCase(), d)
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

  // Reconcile: delete definitions THIS app created previously but no longer declares.
  const declaredKeys = new Set(specs.map((s) => s.description.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredKeys.has(p.name.toLowerCase())) {
      const del = await client.requestV1('DELETE', ITEM(p.id))
      if (!del.ok) failures.push(`delete ${p.name}: ${del.error ?? v1ErrorMessage(del.body, del.status)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some DNS Authentication - Outbound definitions failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} DNS Authentication - Outbound definition(s)`, rollbackData: { entries } }
}
