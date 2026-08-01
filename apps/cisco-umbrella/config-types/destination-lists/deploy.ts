import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient, umbrellaErrorMessage } from '../../lib/umbrellaApi'
import {
  LIST_PATH,
  dataOf,
  extractDestinationListSpecs,
  listDestinations,
  listPath,
  syncDestinations,
  type LiveDestinationList,
} from './_shared'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the list existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** Umbrella destination-list id assigned to the list. */
  listId?: number | string
  /** Prior name + destinations, captured before an update so rollback can restore them. */
  prior?: { name: string; destinations: string[] }
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
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractDestinationListSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveDestinationList>(LIST_PATH)
  if (!listed.ok) {
    return {
      success: false,
      message: `Failed to list destination lists: ${listed.lastError ? umbrellaErrorMessage(listed.lastError) : 'unknown error'}`,
    }
  }
  const liveByName = new Map<string, LiveDestinationList>()
  const liveById = new Map<string, LiveDestinationList>()
  for (const l of listed.items) {
    if (l.name) liveByName.set(l.name.toLowerCase(), l)
    if (l.id != null) liveById.set(String(l.id), l)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const notes: string[] = []

  for (const spec of specs) {
    // Prefer the id stored last deploy (rename-safe), else match by name.
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const liveMatch =
      (priorEntry?.listId != null ? liveById.get(String(priorEntry.listId)) : undefined) ??
      liveByName.get(spec.name.toLowerCase()) ??
      null

    if (liveMatch?.id != null) {
      const id = liveMatch.id

      // Immutable-at-create fields — surface a drift note rather than failing.
      if (liveMatch.access && liveMatch.access !== spec.access) {
        notes.push(`"${spec.name}": access is ${liveMatch.access} in Umbrella and cannot be changed to ${spec.access} (recreate the list to change access)`)
      }
      if (typeof liveMatch.isGlobal === 'boolean' && liveMatch.isGlobal !== spec.isGlobal) {
        notes.push(`"${spec.name}": global scope is fixed at create time and cannot be changed`)
      }

      // Capture the prior destination values before we change anything.
      const before = await listDestinations(client, id)
      const priorDestinations = before.ok
        ? before.items.map((d) => d.destination ?? '').filter(Boolean)
        : []

      if (liveMatch.name && liveMatch.name !== spec.name) {
        const renamed = await client.patch(listPath(id), { name: spec.name })
        if (!renamed.ok) {
          failures.push(`rename ${spec.name}: ${umbrellaErrorMessage(renamed)}`)
          continue
        }
      }

      const sync = await syncDestinations(client, id, spec.destinations)
      if (sync.errors.length) {
        failures.push(`${spec.name}: ${sync.errors.join('; ')}`)
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        listId: id,
        prior: { name: liveMatch.name ?? spec.name, destinations: priorDestinations },
      })
    } else {
      // Create an empty list, then sync destinations (unified batched path).
      const created = await client.post(LIST_PATH, {
        name: spec.name,
        access: spec.access,
        isGlobal: spec.isGlobal,
        destinations: [],
      })
      if (!created.ok) {
        failures.push(`${spec.name}: ${umbrellaErrorMessage(created)}`)
        continue
      }
      const createdList = dataOf<LiveDestinationList>(created.body)
      const id = createdList?.id
      if (id == null) {
        failures.push(`${spec.name}: created but Umbrella returned no list id`)
        continue
      }
      const sync = await syncDestinations(client, id, spec.destinations)
      if (sync.errors.length) failures.push(`${spec.name}: ${sync.errors.join('; ')}`)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, listId: id })
    }
  }

  // Reconcile: delete lists THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => (e.listId != null ? String(e.listId) : '')).filter(Boolean))
  for (const p of prior) {
    if (!p.existed && p.listId != null && !keptIds.has(String(p.listId)) && !declaredNames.has(p.name.toLowerCase())) {
      const res = await client.delete(listPath(p.listId))
      // A 404 means it is already gone — treat as reconciled.
      if (!res.ok && res.status !== 404) failures.push(`delete ${p.name}: ${umbrellaErrorMessage(res)}`)
    }
  }

  const noteSuffix = notes.length ? ` Notes: ${notes.join('; ')}.` : ''
  if (failures.length) {
    return {
      success: false,
      message: `Some destination lists failed: ${failures.join('; ')}.${noteSuffix}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} destination list(s).${noteSuffix}`,
    artifacts: { applied: entries.map((e) => e.name) },
    rollbackData: { entries },
  }
}
