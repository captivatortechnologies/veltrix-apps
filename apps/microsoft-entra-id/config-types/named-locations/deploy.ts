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
  extractNamedLocationSpecs,
  IP_ODATA_TYPE,
  COUNTRY_ODATA_TYPE,
  type LiveNamedLocation,
  type NamedLocationSpec,
} from './validate'

const BASE = '/identity/conditionalAccess/namedLocations'

/** One deployed item, stored on the deployment so the next deploy + rollback can
 *  match live objects by stable id (rename-safe) and undo their changes. */
export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the location existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** External (Entra) id assigned to the location. */
  id?: string
  /** Prior live body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

export function buildLocationBody(spec: NamedLocationSpec): Record<string, unknown> {
  if (spec.type === 'ip') {
    return {
      '@odata.type': IP_ODATA_TYPE,
      displayName: spec.name,
      isTrusted: spec.isTrusted,
      ipRanges: spec.ipRanges.map((cidr) => ({
        '@odata.type': cidr.includes(':')
          ? '#microsoft.graph.iPv6CidrRange'
          : '#microsoft.graph.iPv4CidrRange',
        cidrAddress: cidr,
      })),
    }
  }
  return {
    '@odata.type': COUNTRY_ODATA_TYPE,
    displayName: spec.name,
    countriesAndRegions: spec.countries,
    includeUnknownCountriesAndRegions: spec.includeUnknown,
  }
}

/** Capture the fields we manage from a live location, for rollback restore. */
function snapshotLive(live: LiveNamedLocation): Record<string, unknown> {
  const base: Record<string, unknown> = { '@odata.type': live['@odata.type'], displayName: live.displayName }
  if (live['@odata.type'] === IP_ODATA_TYPE) {
    base.isTrusted = live.isTrusted ?? false
    base.ipRanges = live.ipRanges ?? []
  } else {
    base.countriesAndRegions = live.countriesAndRegions ?? []
    base.includeUnknownCountriesAndRegions = live.includeUnknownCountriesAndRegions ?? false
  }
  return base
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

  const specs = extractNamedLocationSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveNamedLocation>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list named locations: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveNamedLocation>()
  const liveById = new Map<string, LiveNamedLocation>()
  for (const loc of listed.items) {
    if (loc.displayName) liveByName.set(loc.displayName.toLowerCase(), loc)
    if (loc.id) liveById.set(loc.id, loc)
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
    const body = buildLocationBody(spec)

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
      const created = parseJson<LiveNamedLocation>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete locations THIS app created previously but no longer declares.
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
      message: `Some named locations failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} named location(s)`,
    rollbackData: { entries },
  }
}
